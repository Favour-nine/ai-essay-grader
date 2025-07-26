console.log("Server starting...");

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const vision = require("@google-cloud/vision");
const path = require("path");
const sharp = require("sharp");
const fs = require("fs");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(cors());

// Multer config: uploads folder
const upload = multer({ dest: "uploads/" });

// Google Cloud Vision client
const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, "google-vision-key.json"),
});

// OpenAI GPT client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Upload and OCR route
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const inputPath = req.file.path;
    const outputPath = `uploads/processed-${Date.now()}.png`;

    // 1. Preprocess the image
    await sharp(inputPath)
      .grayscale()
      .resize(1000)
      .toFile(outputPath);

    // 2. Extract text using Google Vision
    const [result] = await client.documentTextDetection(outputPath);
    const rawText = result.fullTextAnnotation?.text || "No text detected.";
    const cleanedText = rawText.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

    // 3. Use GPT-4 to correct grammar, spelling, punctuation
    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that corrects grammar, punctuation, and spelling errors in OCR-transcribed essays without changing meaning.",
        },
        {
          role: "user",
          content: cleanedText,
        },
      ],
      temperature: 0.3,
    });

    const correctedText = gptResponse.choices[0].message.content;

    // 4. Clean up temp files
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    // 5. Respond with both raw and corrected text
    res.json({
      rawText: cleanedText,
      correctedText,
    });
  } catch (err) {
    console.error("OCR or GPT Error:", err.message || err);
    res.status(500).json({ error: "OCR or GPT processing failed" });
  }
});

// Start the server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
