const express = require('express');
const axios = require('axios');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const { createClient } = require('@deepgram/sdk');
const { OpenAI } = require('openai');
const cosineSimilarity = require('compute-cosine-similarity');
const util = require('util');


// Load environment variables
dotenv.config();

const app = express();
const storage = multer.memoryStorage(); // No need for destination function here
const upload = multer({ storage })

app.use(express.json());
app.use(cors());



// Configure AWS S3
const s3 = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ID,
    secretAccessKey: process.env.AWS_SECRET
  }
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});




// SingleStore connection details
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
});


// Connect to SingleStore
connection.connect((err) => {
  if (err) {
    console.error('Error connecting to SingleStore:', err.stack);
    return;
  }
  console.log('Connected to SingleStore as id ' + connection.threadId);
});

// Middleware to verify JWT
const authenticateJWT = (req, res, next) => {
  const token = req.headers['authorization'] && req.headers['authorization'].split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};
const query = (sql, values) => {
  return new Promise((resolve, reject) => {
      connection.query(sql, values, (error, results) => {
          if (error) {
              return reject(error);
          }
          resolve(results);
      });
  });
};
// Function to extract text from PDF file
const extractTextFromPDF = async (pdfBuffer) => {
  try {
    const pdfData = await pdf(pdfBuffer);
    return pdfData.text;
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    throw error;
  }
};

// Function to extract text from DOC file
const extractTextFromDOC = async (docBuffer) => {
  try {
    const result = await mammoth.extractRawText({ buffer: docBuffer });
    return result.value;
  } catch (error) {
    console.error('Error extracting text from DOC:', error);
    throw error;
  }
};

// Function to transcribe audio using Deepgram
const audioFun = async (audioBuffer) => {
  try {
      // STEP 1: Create a Deepgram client using the API key
      const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

      // STEP 2: Call the transcribeFile method with the audio payload and options
      const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
          audioBuffer, // Use the provided audio buffer
          {
              model: "nova-2",
              smart_format: true,
          }
      );

      // Log the result to understand its structure
      console.log("Transcription result:", result.results.channels[0].alternatives[0].transcript);

      // Extract words from the result object
      return result.results.channels[0].alternatives[0].transcript;

  } catch (error) {
      console.error("Error transcribing audio:", error);
      throw error;
  }
};


// Function to generate embedding using OpenAI
const generateEmbedding = async (text) => {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-ada-002",
      input: text
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error("Error generating embedding:", error);
    throw error;
  }
};

// Function to format date for MySQL
const formatDateToMySQL = (datetime) => {
  const pad = (number) => number.toString().padStart(2, '0');

  const year = datetime.getFullYear();
  const month = pad(datetime.getMonth() + 1);
  const day = pad(datetime.getDate());
  const hours = pad(datetime.getHours());
  const minutes = pad(datetime.getMinutes());
  const seconds = pad(datetime.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};
const generateTitle = async (text) => {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "Generate a concise and informative title for the following text:"
        },
        {
          role: "user",
          content: text
        }
      ]
    });
    return response.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error generating title:", error);
    throw error;
  }
};

// Route for Google authentication
app.post('/auth/google', async (req, res) => {
  const { tokenId } = req.body;

  try {
    const response = await axios.get(`https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=${tokenId}`);
    const userData = response.data;

    connection.query('SELECT * FROM users WHERE googleId = ?', [userData.sub], (err, results) => {
      if (err) {
        res.status(500).json({ success: false, message: 'Database query error' });
        return;
      }

      if (results.length === 0) {
        const newUser = {
          googleId: userData.sub,
          email: userData.email,
          name: userData.name
        };
        connection.query('INSERT INTO users SET ?', newUser, (err) => {
          if (err) {
            res.status(500).json({ success: false, message: 'Database insert error' });
            return;
          }

          // Generate JWT token
          const token = jwt.sign({ googleId: newUser.googleId }, process.env.JWT_SECRET, { expiresIn: '1h' });
          res.json({ success: true, user: newUser, token });
        });
      } else {
        // User found, send user data
        const token = jwt.sign({ googleId: results[0].googleId }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ success: true, user: results[0], token });
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Invalid token' });
  }
});

//Audio ai completed
app.post('/upload-transcribe', authenticateJWT, upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No audio file uploaded.');
  }

  try {
    // Define the S3 key and upload the audio file to S3
    const audioKey = `audio/${Date.now()}_${req.file.originalname}`;
    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: audioKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    };

    // Upload to S3
    await s3.send(new PutObjectCommand(uploadParams));
    // Download the audio file from S3
    const getObjectParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: audioKey,
    };
    const command = new GetObjectCommand(getObjectParams);
    const { Body } = await s3.send(command);

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of Body) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);
    const transcriptionText = await audioFun(audioBuffer);
    const title = await generateTitle(transcriptionText);

    if (!transcriptionText) {
      return res.status(500).send('Error in transcription.');
    }

   
    const embedding = await generateEmbedding(transcriptionText);
    if (!embedding) {
      return res.status(500).send('Error generating embedding.');
    }

    const currentDate = new Date();

    
    const sql = 'INSERT INTO Audio (googleId, transcription, audio, title, embedding, date) VALUES (?, ?, ?, ?, ?, ?)';
    const values = [req.user.googleId, transcriptionText, audioKey, title, JSON.stringify(embedding), formatDateToMySQL(currentDate)];

    connection.query(sql, values, (err) => {
      if (err) {
        console.error('Error inserting into database:', err);
        return res.status(500).send('Error processing request.');
      }
      res.status(200).json({
        transcription: transcriptionText,
        embedding: embedding,
        date: formatDateToMySQL(currentDate)
      });
    });

  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).send('Error processing request.');
  }
});
//completed
app.get('/audiofiles', authenticateJWT, async (req, res) => {
  try {
   
    const sql = "SELECT id, title, date FROM Audio WHERE googleId = ?";
    const values = [req.user.googleId];


    connection.query(sql, values, (err, results) => {
      if (err) {
        console.error('Error fetching Audio list:', err);
        return res.status(500).json({ error: 'Error fetching Audio list' });
      }
     
      res.status(200).json(results);
    });
  } catch (error) {
    console.error('Error fetching Audio list:', error);
    res.status(500).json({ error: 'Error fetching Audio list' });
  }
});

//completed
app.post('/audioask/:id', authenticateJWT, async (req, res) => {
  try {
    const { question } = req.body;
    const id = req.params.id;

    if (!question) {
      return res.status(400).send('Question is required.');
    }

    // Generate embedding for the question
    const questionEmbedding = await generateEmbedding(question);

    // Retrieve stored transcription and embedding from the database and verify googleId
    const sql = "SELECT transcription, embedding FROM Audio WHERE id = ? AND googleId = ?";
    const values = [id, req.user.googleId];
    connection.query(sql, values, async (err, results) => {
      if (err) {
        console.error('Error querying database:', err);
        return res.status(500).json({ error: 'Error querying database' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'No data found for the provided ID and googleId' });
      }

      try {
        const transcription = results[0].transcription;
        const rawEmbedding = results[0].embedding;

     

        let embedding;
        if (typeof rawEmbedding === 'string') {
          // Attempt to parse if it's a JSON string
          try {
            embedding = JSON.parse(rawEmbedding);
          } catch (parseError) {
            console.error('Invalid JSON format in embedding field:', parseError);
            return res.status(500).json({ error: 'Invalid JSON format in embedding field' });
          }
        } else if (typeof rawEmbedding === 'object') {
          // Directly use if it's already an object/array
          embedding = rawEmbedding;
        } else {
          // Handle unexpected type
          console.error('Unexpected type for embedding:', typeof rawEmbedding);
          return res.status(500).json({ error: 'Unexpected type for embedding' });
        }

        // Validate the embedding format
        if (!Array.isArray(embedding) || embedding.some(isNaN)) {
          console.error('Invalid embedding format:', embedding);
          return res.status(500).json({ error: 'Invalid embedding format' });
        }

        // Calculate similarity between question embedding and audio embedding
        const similarity = cosineSimilarity(questionEmbedding, embedding);

        // Use OpenAI to generate a response based on the retrieved transcription and the question
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: `Answer the question based on the following context:\n\n${transcription}\n\nQuestion: ${question}` }
          ],
          max_tokens: 200
        });

        const answer = response.choices[0].message.content.trim();
        res.status(200).json({ answer: answer, similarity: similarity });
      } catch (error) {
        console.error('Error generating response:', error);
        res.status(500).json({ error: 'Error generating response' });
      }
    });
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Error processing request' });
  }
});

// completed
app.get('/audiofile/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;

  try {
      // Query to retrieve title, date, and other information from the Audio table based on id and googleId
      const sql = "SELECT * FROM Audio WHERE id = ? AND googleId = ?";
      
      // Execute query with id and googleId as parameters
      const results = await query(sql, [id, req.user.googleId]);

      // Check if results are empty
      if (results.length === 0) {
          return res.status(404).json({ error: 'Audio not found' });
      }

      // Return title, date, and other information
      const audioFile = results[0];
      res.status(200).json({ audioFile });
  } catch (error) {
      console.error('Error fetching Audio:', error);
      res.status(500).json({ error: 'Error fetching Audiofiles' });
  }
});

app.delete('/audiofile/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;

  try {
      // Query to delete the audio file based on id and googleId
      const sql = "DELETE FROM Audio WHERE id = ? AND googleId = ?";
      
      // Execute query with id and googleId as parameters
      const results = await query(sql, [id, req.user.googleId]);

      // Check if any rows were affected (i.e., a row was actually deleted)
      if (results.affectedRows === 0) {
          return res.status(404).json({ error: 'Audio not found' });
      }

      // Return success message
      res.status(200).json({ message: 'Audio deleted successfully' });
  } catch (error) {
      console.error('Error deleting audio:', error);
      res.status(500).json({ error: 'Error deleting audio' });
  }
});


//notesAi completed
app.post('/upload-notes', authenticateJWT, upload.single('file'), async (req, res) => {
  console.log('Request body:', req.body);
  console.log('Request file:', req.file);

  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  try {
    const file = req.file;
    const { title, category, exam, paper, subject, topics } = req.body;

    if (!title || !category || !exam || !paper || !subject || !topics) {
      return res.status(400).send('All fields (title, category, exam, paper, subject, topics) are required.');
    }

    // Define the S3 key and upload the file to S3
    const fileKey = `notes/${Date.now()}_${file.originalname}`;
    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileKey,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    // Upload to S3
    await s3.send(new PutObjectCommand(uploadParams));

    // Download the file from S3
    const getObjectParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileKey,
    };
    const command = new GetObjectCommand(getObjectParams);
    const { Body } = await s3.send(command);

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of Body) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    // Extract text from the file based on its MIME type
    let fileText;
    if (file.mimetype === 'application/pdf') {
      fileText = await extractTextFromPDF(fileBuffer);
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      fileText = await extractTextFromDOC(fileBuffer);
    }
     else {
      return res.status(400).send('Unsupported file type.');
    }

    if (!fileText) {
      return res.status(500).send('Error extracting text from file.');
    }

    // Generate embedding from the extracted text
    const embedding = await generateEmbedding(fileText);
    if (!embedding) {
      return res.status(500).send('Error generating embedding.');
    }

    // Prepare SQL statement for insertion
    const sql = 'INSERT INTO notes (title, category, exam, paper, subject, topics, text, vector, googleId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const values = [title, category, exam, paper, subject, topics, fileText.trim(), JSON.stringify(embedding), req.user.googleId];

    // Insert the extracted text and embedding into the database
    connection.query(sql, values, (err) => {
      if (err) {
        console.error('Error storing file embedding:', err);
        return res.status(500).send('Error storing file embedding.');
      }
      res.status(200).send('File uploaded and processed successfully.');
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).send('Error uploading file.');
  }
});

app.post('/noteask/:id', authenticateJWT, async (req, res) => {
  try {
    const { question } = req.body;
    const id = req.params.id;

    if (!question) {
      return res.status(400).send('Question is required.');
    }

    // Generate embedding for the question
    const questionEmbedding = await generateEmbedding(question);

    // Retrieve stored note text and embedding from the database and verify googleId
    const sql = "SELECT text, vector FROM notes WHERE id = ? AND googleId = ?";
    const values = [id, req.user.googleId];
    connection.query(sql, values, async (err, results) => {
      if (err) {
        console.error('Error querying database:', err);
        return res.status(500).json({ error: 'Error querying database' });
      }

      if (results.length === 0) {
        return res.status(404).json({ error: 'No data found for the provided ID and googleId' });
      }

      try {
        const text = results[0].text;
        const rawEmbedding = results[0].vector;

        let embedding;
        if (typeof rawEmbedding === 'string') {
          // Attempt to parse if it's a JSON string
          try {
            embedding = JSON.parse(rawEmbedding);
          } catch (parseError) {
            console.error('Invalid JSON format in embedding field:', parseError);
            return res.status(500).json({ error: 'Invalid JSON format in embedding field' });
          }
        } else if (typeof rawEmbedding === 'object') {
          // Directly use if it's already an object/array
          embedding = rawEmbedding;
        } else {
          // Handle unexpected type
          console.error('Unexpected type for embedding:', typeof rawEmbedding);
          return res.status(500).json({ error: 'Unexpected type for embedding' });
        }

        // Validate the embedding format
        if (!Array.isArray(embedding) || embedding.some(isNaN)) {
          console.error('Invalid embedding format:', embedding);
          return res.status(500).json({ error: 'Invalid embedding format' });
        }

        // Calculate similarity between question embedding and note embedding
        const similarity = cosineSimilarity(questionEmbedding, embedding);

        // Use OpenAI to generate a response based on the retrieved note text and the question
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: `Answer the question based on the following context:\n\n${text}\n\nQuestion: ${question}` }
          ],
          max_tokens: 200
        });

        const answer = response.choices[0].message.content.trim();
        res.status(200).json({ answer: answer, similarity: similarity });
      } catch (error) {
        console.error('Error generating response:', error);
        res.status(500).json({ error: 'Error generating response' });
      }
    });
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Error processing request' });
  }
});

app.delete('/notes/:id', authenticateJWT, (req, res) => {
  const id = req.params.id;
  const googleId = req.user.googleId; // Assuming googleId is retrieved from JWT

  // Validate the ID
  if (!id) {
    return res.status(400).send('ID is required.');
  }

  // SQL query to delete the record
  const sql = "DELETE FROM notes WHERE id = ? AND googleId = ?";
  const values = [id, googleId];

  connection.query(sql, values, (err, results) => {
    if (err) {
      console.error('Error deleting record:', err);
      return res.status(500).json({ error: 'Error deleting record' });
    }

    if (results.affectedRows === 0) {
      return res.status(404).json({ error: 'No record found with the provided ID and googleId' });
    }

    res.status(200).json({ message: 'Record deleted successfully' });
  });
});

app.get('/notes/:id', authenticateJWT, (req, res) => {
  const id = req.params.id;
  const googleId = req.user.googleId; // Assuming googleId is retrieved from JWT

  // Validate the ID
  if (!id) {
    return res.status(400).send('ID is required.');
  }

  // SQL query to get the record
  const sql = "SELECT * FROM notes WHERE id = ? AND googleId = ?";
  const values = [id, googleId];

  connection.query(sql, values, (err, results) => {
    if (err) {
      console.error('Error querying database:', err);
      return res.status(500).json({ error: 'Error querying database' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'No record found with the provided ID and googleId' });
    }

    res.status(200).json(results[0]);
  });
});

app.get('/notes', authenticateJWT, (req, res) => {
  const googleId = req.user.googleId; // Assuming googleId is retrieved from JWT

  // SQL query to get all notes for the authenticated user
  const sql = "SELECT * FROM notes WHERE googleId = ?";
  const values = [googleId];

  connection.query(sql, values, (err, results) => {
    if (err) {
      console.error('Error querying database:', err);
      return res.status(500).json({ error: 'Error querying database' });
    }

    res.status(200).json(results);
  });
});



//testAi completed
app.post('/uploadpapers', authenticateJWT, upload.single('file'), async (req, res) => {
  console.log('Request body:', req.body);
  console.log('Request file:', req.file);

  if (!req.file) {
    return res.status(400).send('No file uploaded.');
  }

  try {
    const file = req.file;
    const fileBuffer = file.buffer;
    const fileMimeType = file.mimetype;

    let fileText;

    // Extract text based on file type
    if (fileMimeType === 'application/pdf') {
      fileText = await extractTextFromPDF(fileBuffer);
    } else if (fileMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      fileText = await extractTextFromDOC(fileBuffer);
    } else {
      return res.status(400).send('Unsupported file type.');
    }

    if (!fileText) {
      return res.status(500).send('Error extracting text from file.');
    }

    // Generate a title based on the extracted text
    const generatedTitle = await generateTitle(fileText);

    // Generate embedding from the extracted text
    const embedding = await generateEmbedding(fileText);

    // Get the current date
    const currentDate = formatDateToMySQL(new Date());

    // Prepare SQL statement for insertion into 'previouspapers' table using parameterized query
    const sql = "INSERT INTO previouspapers (title, text, vector, date, googleId) VALUES (?, ?, ?, ?, ?)";
    const values = [generatedTitle, fileText.trim(), JSON.stringify(embedding), currentDate, req.user.googleId];

    // Log values to debug any potential issues
    console.log('SQL Query:', sql);
    console.log('Values:', values);

    // Insert the extracted text and embedding into the 'previouspapers' table
    connection.query(sql, values, (err) => {
      if (err) {
        console.error('Error storing file embedding:', err.message);
        return res.status(500).json({ error: 'Error storing file embedding' });
      } else {
        console.log('File embedding stored successfully');
        res.status(200).json({ message: 'File uploaded and processed successfully' });
      }
    });

  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Error uploading file' });
  }
});
app.post('/askprevious/:id', authenticateJWT, async (req, res) => {
  const { question } = req.body;
  const id = req.params.id;

  if (!question || !id) {
      return res.status(400).json({ error: 'Question and ID are required' });
  }

  try {
      const questionEmbedding = await generateEmbedding(question);

      // Retrieve specific text and vector from the 'previouspapers' table based on ID and user's googleId
      const sql = "SELECT text, vector FROM previouspapers WHERE id = ? AND googleId = ?";
      connection.query(sql, [id, req.user.googleId], async (err, results) => {
          if (err) {
              console.error('Error querying database:', err);
              return res.status(500).json({ error: 'Error querying database' });
          }

          if (results.length === 0) {
              return res.status(404).json({ error: 'No data found for the provided ID and googleId' });
          }

          // Extract text and vector from the result
          const text = results[0].text;
          const rawVector = results[0].vector;

          let storedVector;
          if (typeof rawVector === 'string') {
              // Attempt to parse if it's a JSON string
              try {
                  storedVector = JSON.parse(rawVector);
              } catch (parseError) {
                  console.error('Invalid JSON format in vector field:', parseError);
                  return res.status(500).json({ error: 'Invalid JSON format in vector field' });
              }
          } else if (typeof rawVector === 'object') {
              // Directly use if it's already an object/array
              storedVector = rawVector;
          } else {
              // Handle unexpected type
              console.error('Unexpected type for vector:', typeof rawVector);
              return res.status(500).json({ error: 'Unexpected type for vector' });
          }

          // Validate the vector format
          if (!Array.isArray(storedVector) || storedVector.some(isNaN)) {
              console.error('Invalid vector format:', storedVector);
              return res.status(500).json({ error: 'Invalid vector format' });
          }

          // Calculate similarity between question embedding and stored vector
          const similarity = cosineSimilarity(questionEmbedding, storedVector);

          // Use OpenAI to generate a response based on the retrieved text and the question
          try {
              const response = await openai.chat.completions.create({
                  model: "gpt-4o",
                  messages: [
                      { role: "system", content: "Generate a response based on the provided context:" },
                      { role: "user", content: `Context: ${text}\nQuestion: ${question}` }
                  ],
                  max_tokens: 200
              });

              const answer = response.choices[0].message.content.trim();
              res.status(200).json({ answer: answer, similarity: similarity });
          } catch (error) {
              console.error('Error generating response:', error);
              res.status(500).json({ error: 'Error generating response' });
          }
      });
  } catch (error) {
      console.error('Error processing request:', error);
      res.status(500).json({ error: 'Error processing request' });
  }
});

app.get('/pqfiles', authenticateJWT, (req, res) => {
  const sql = "SELECT id, title, date FROM previouspapers WHERE googleId = ?";
  
  // Use the authenticated user's googleId to filter results
  connection.query(sql, [req.user.googleId], (err, results) => {
      if (err) {
          console.error('Error querying database:', err);
          return res.status(500).json({ error: 'Error querying database' });
      }

      res.status(200).json(results);
  });
});

app.get('/pqfile/:id', authenticateJWT, (req, res) => {
  const id = req.params.id;

  const sql = "SELECT * FROM previouspapers WHERE id = ? AND googleId = ?";
  connection.query(sql, [id, req.user.googleId], (err, results) => {
      if (err) {
          console.error('Error querying database:', err);
          return res.status(500).json({ error: 'Error querying database' });
      }

      if (results.length === 0) {
          return res.status(404).json({ error: 'No data found for the provided ID' });
      }

      res.status(200).json(results[0]);
  });
});


app.delete('/pqfile/:id', authenticateJWT, (req, res) => {
  const id = req.params.id;

  const sql = "DELETE FROM previouspapers WHERE id = ? AND googleId = ?";
  connection.query(sql, [id, req.user.googleId], (err, results) => {
      if (err) {
          console.error('Error querying database:', err);
          return res.status(500).json({ error: 'Error querying database' });
      }

      if (results.affectedRows === 0) {
          return res.status(404).json({ error: 'No data found for the provided ID' });
      }

      res.status(200).json({ message: 'File deleted successfully' });
  });
});

//aichat
app.post('/aichat', authenticateJWT, async (req, res) => {
  const { question } = req.body;

  if (!question) {
      return res.status(400).json({ error: 'Question is required' });
  }

  try {
      const query = util.promisify(connection.query).bind(connection);
      
      const googleId = req.user.googleId; // Get Google ID from authenticated user

      const databases = [];

      // Determine which databases to query based on keywords
      if (question.toLowerCase().includes('paper') || question.toLowerCase().includes('previous')) {
          databases.push({
              name: "previouspapers",
              queryText: "SELECT text, vector FROM previouspapers WHERE googleId = ?",
              fieldText: 'text',
              fieldVector: 'vector'
          });
      }
      if (question.toLowerCase().includes('audio')) {
          databases.push({
              name: "Audio",
              queryText: "SELECT transcription, embedding FROM Audio WHERE googleId = ?",
              fieldText: 'transcription',
              fieldVector: 'embedding'
          });
      }
      if (question.toLowerCase().includes('question') || question.toLowerCase().includes('notes')) {
          databases.push({
              name: "notes",
              queryText: "SELECT text, vector FROM notes WHERE googleId = ?",
              fieldText: 'text',
              fieldVector: 'vector'
          });
      }

      // If no keywords match, default to querying all databases
      if (databases.length === 0) {
          databases.push(
              {
                  name: "previouspapers",
                  queryText: "SELECT text, vector FROM previouspapers WHERE googleId = ?",
                  fieldText: 'text',
                  fieldVector: 'vector'
              },
              {
                  name: "Audio",
                  queryText: "SELECT transcription, embedding FROM Audio WHERE googleId = ?",
                  fieldText: 'transcription',
                  fieldVector: 'embedding'
              },
              {
                  name: "notes",
                  queryText: "SELECT text, vector FROM notes WHERE googleId = ?",
                  fieldText: 'text',
                  fieldVector: 'vector'
              }
          );
      }

      const results = [];
      for (const db of databases) {
          const queryResult = await query(db.queryText, [googleId]);
          if (queryResult.length > 0) {
              results.push(...queryResult.map(res => ({
                  context: res[db.fieldText],
                  embedding: res[db.fieldVector]
              })));
          }
      }

      if (results.length === 0) {
          return res.status(404).json({ error: 'No results found' });
      }

      // Create a combined context from all results
      const combinedContext = results.map(res => res.context).join("\n");

      // Call OpenAI API to get a response
      const openaiResponse = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
              { role: "system", content: "Give a short response in 2-4 lines." },
              { role: "user", content: `Answer the question based on the following context:\n\n${combinedContext}\n\nQuestion: ${question}` }
          ],
          max_tokens: 200
      });

      const answer = openaiResponse.choices[0].message.content.trim();
      const similarity = 1; // Adjust if needed

      res.status(200).json({ answer: answer, similarity });
  } catch (error) {
      console.error('Error processing request:', error);
      res.status(500).json({ error: 'Error processing request' });
  }
});


app.post('/students', authenticateJWT, (req, res) => {
  const { name, studentNumber, email } = req.body;
  const googleId = req.user.googleId; // Assuming googleId is set in req.user by authenticateJWT

  if (!name || !studentNumber || !email || !googleId) {
      return res.status(400).send({ error: 'Please provide name, student number, email, and ensure you are authenticated' });
  }

  const sql = 'INSERT INTO students (name, student_number, email, googleId) VALUES (?, ?, ?, ?)';
  connection.query(sql, [name, studentNumber, email, googleId], (err, result) => {
      if (err) {
          return res.status(500).send({ error: 'Database error' });
      }
      res.status(201).send({ message: 'Student added successfully', studentId: result.insertId });
  });
});

// Get all students for the authenticated user
app.get('/students', authenticateJWT, (req, res) => {
  const googleId = req.user.googleId; // Assuming googleId is set in req.user by authenticateJWT

  const sql = 'SELECT * FROM students WHERE googleId = ?';
  
  connection.query(sql, [googleId], (err, results) => {
      if (err) {
          return res.status(500).send({ error: 'Database error' });
      }
      res.status(200).send({ students: results });
  });
});
app.get('/student/:id', authenticateJWT, (req, res) => {
  const { id } = req.params;
  const googleId = req.user.googleId; // Assuming googleId is set in req.user by authenticateJWT

  if (!id) {
      return res.status(400).send({ error: 'Student ID is required' });
  }

  const sql = 'SELECT * FROM students WHERE id = ? AND googleId = ?';

  connection.query(sql, [id, googleId], (err, results) => {
      if (err) {
          return res.status(500).send({ error: 'Database error' });
      }

      if (results.length === 0) {
          return res.status(404).send({ message: 'Student not found or not authorized to view' });
      }

      res.status(200).send({ student: results[0] });
  });
});

// Delete a student by ID for the authenticated user
app.delete('/student/:id', authenticateJWT, (req, res) => {
  const { id } = req.params;
  const googleId = req.user.googleId; // Assuming googleId is set in req.user by authenticateJWT

  if (!id) {
      return res.status(400).send({ error: 'Student ID is required' });
  }

  const sql = 'DELETE FROM students WHERE id = ? AND googleId = ?';

  connection.query(sql, [id, googleId], (err, results) => {
      if (err) {
          return res.status(500).send({ error: 'Database error' });
      }

      if (results.affectedRows === 0) {
          return res.status(404).send({ message: 'Student not found or not authorized to delete' });
      }

      res.status(200).send({ message: 'Student deleted successfully' });
  });
});






app.listen(3002, () => console.log('Server running on port 3002'));
