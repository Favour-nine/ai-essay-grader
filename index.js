console.log("Server starting...");
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const path = require('path');

// Initialize express app
const app = express();
app.use(cors());

// Set up Multer for handling file uploads
const upload = multer({ dest: 'uploads/' });

// Configure Google Vision API client
const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, 'google-vision-key.json'),
});

// Route: Upload a scanned essay and run OCR
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const [result] = await client.documentTextDetection(req.file.path);
    const text = result.fullTextAnnotation?.text || 'No text detected.';
    res.json({ text });
  } catch (err) {
    console.error('OCR error:', err);
    res.status(500).json({ error: 'OCR failed' });
  }
});


// Start the server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
