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
app.use(express.json());

// Store uploads temporarily in "temp/"
const upload = multer({ dest: "temp/" });

const client = new vision.ImageAnnotatorClient({
  keyFilename: path.join(__dirname, "google-vision-key.json"),
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const folder = req.body.folder;
    if (!folder) return res.status(400).json({ error: "Folder name is required." });

    const folderPath = path.join(__dirname, "uploads", folder);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });

    const inputPath = req.file.path;
    const timestamp = Date.now();

    // Save original image with unique name
    const ext = path.extname(req.file.originalname) || ".jpg";
    const originalName = `${timestamp}${ext}`;
    const originalImagePath = path.join(folderPath, originalName);
    fs.copyFileSync(inputPath, originalImagePath);

    // Preprocess image for OCR
    const processedImagePath = path.join(folderPath, `processed-${timestamp}.png`);
    await sharp(inputPath).grayscale().resize(1000).toFile(processedImagePath);

    const [result] = await client.documentTextDetection(processedImagePath);
    const rawText = result.fullTextAnnotation?.text || "No text detected.";
    const cleanedText = rawText.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant that corrects grammar, punctuation, and spelling errors in OCR-transcribed essays without changing meaning.",
        },
        { role: "user", content: cleanedText },
      ],
      temperature: 0.3,
    });

    const correctedText = gptResponse.choices[0].message.content;

    const outputTextPath = path.join(folderPath, `${timestamp}.txt`);
    fs.writeFileSync(outputTextPath, correctedText);

    // Clean up temp and processed
    fs.unlinkSync(inputPath);
    fs.unlinkSync(processedImagePath);

    res.json({
      message: "Image and corrected text saved successfully.",
      image: originalName,
      textFile: `${timestamp}.txt`,
    });
  } catch (err) {
    console.error("OCR or GPT Error:", err.message || err);
    res.status(500).json({ error: "OCR or GPT processing failed" });
  }
});

app.get("/folders", (req, res) => {
  const basePath = path.join(__dirname, "uploads");
  fs.readdir(basePath, { withFileTypes: true }, (err, files) => {
    if (err) return res.status(500).json({ error: "Failed to read folders." });
    const folders = files.filter((f) => f.isDirectory()).map((f) => f.name);
    res.json({ folders });
  });
});

app.post("/create-folder", (req, res) => {
  const { folderName } = req.body;
  if (!folderName) return res.status(400).json({ error: "Folder name is required." });

  const safeName = folderName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeName) return res.status(400).json({ error: "Invalid folder name." });

  const folderPath = path.join(__dirname, "uploads", safeName);
  if (fs.existsSync(folderPath)) {
    return res.status(400).json({ error: "Folder already exists." });
  }

  fs.mkdir(folderPath, { recursive: true }, (err) => {
    if (err) return res.status(500).json({ error: "Failed to create folder." });
    res.status(201).json({ message: "Folder created successfully." });
  });
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
