console.log("Server starting...");
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const vision = require('@google-cloud/vision');
const path = require('path');
const sharp = require('sharp');
const fs = require('fs');
require('dotenv').config();
const { OpenAI } = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, 
});


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
    const inputPath = req.file.path;
    const outputPath = `uploads/processed-${Date.now()}.png`;

    // Preprocess: convert to grayscale and resize
    await sharp(inputPath)
      .grayscale()
      .resize({ width: 1200 }) // Increased for better OCR interpretation
      .normalize()              // Improves contrast
      .sharpen()                // Makes edges clearer
      .toFile(outputPath);

    const [result] = await client.textDetection(outputPath);
    const rawText = result.fullTextAnnotation?.text || 'No text detected.';
    const cleanedText = rawText.replace(/\n+/g, ' '); // replaces all \n with a space


    // Clean up both raw and processed images
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    res.json({ text: cleanedText });
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
