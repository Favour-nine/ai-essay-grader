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
const assessmentsPath = path.join(__dirname, "data", "assessments.json");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));


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


app.post("/create-assessment", (req, res) => {
  const { name, folder, rubric, description } = req.body;

  // Validate
  if (!name || !folder || !rubric) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Load existing assessments
    const existingData = fs.existsSync(assessmentsPath)
      ? JSON.parse(fs.readFileSync(assessmentsPath, "utf-8"))
      : [];

    // Create new assessment
    const newAssessment = {
      name,
      folder,
      rubric,
      description,
      createdAt: new Date().toISOString(),
    };

    // Append and save
    existingData.push(newAssessment);
    fs.writeFileSync(assessmentsPath, JSON.stringify(existingData, null, 2));

    res.status(201).json({ message: "Assessment created successfully." });
  } catch (err) {
    console.error("Failed to save assessment:", err);
    res.status(500).json({ error: "Could not save assessment." });
  }
});


// POST /create-rubric
app.post("/create-rubric", (req, res) => {
  const { name, criteria } = req.body;
  if (!name || !criteria || !Array.isArray(criteria)) {
    return res.status(400).json({ error: "Invalid rubric data." });
  }

  const rubricDir = path.join(__dirname, "data", "rubrics");
  if (!fs.existsSync(rubricDir)) fs.mkdirSync(rubricDir, { recursive: true });

  const filePath = path.join(rubricDir, `${name}.json`);
  fs.writeFile(filePath, JSON.stringify({ name, criteria }, null, 2), (err) => {
    if (err) return res.status(500).json({ error: "Failed to save rubric." });
    res.status(201).json({ message: "Rubric created successfully." });
  });
});

// GET /rubrics
app.get("/rubrics", (req, res) => {
  const rubricDir = path.join(__dirname, "data", "rubrics");
  fs.readdir(rubricDir, (err, files) => {
    if (err) return res.status(500).json({ error: "Failed to read rubrics." });

    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    res.json({ rubrics: jsonFiles });
  });
});

// Load rubric by name (JSON file)
app.get("/rubric/:name", (req, res) => {
  const rubricPath = path.join(__dirname, "data", "rubrics", `${req.params.name}`);
  fs.readFile(rubricPath, "utf8", (err, data) => {
    if (err) return res.status(404).json({ error: "Rubric not found" });
    try {
      res.json(JSON.parse(data));
    } catch (e) {
      res.status(500).json({ error: "Invalid rubric format" });
    }
  });
});


// GET /assessments
app.get("/assessments", (req, res) => {
  const filePath = path.join(__dirname, "data", "assessments.json");
  if (!fs.existsSync(filePath)) return res.json({ assessments: [] });

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) return res.status(500).json({ error: "Failed to read assessments." });
    try {
      const assessments = JSON.parse(data);
      res.json({ assessments });
    } catch {
      res.status(500).json({ error: "Invalid assessment data." });
    }
  });
});

// GET /essays/:folder
app.get("/essays/:folder", (req, res) => {
  const folderName = req.params.folder;
  const folderPath = path.join(__dirname, "uploads", folderName);

  if (!fs.existsSync(folderPath)) return res.status(404).json({ error: "Folder not found" });

  fs.readdir(folderPath, (err, files) => {
    if (err) return res.status(500).json({ error: "Failed to read folder." });

    const txtFiles = files.filter(f => f.endsWith(".txt"));
    res.json({ essays: txtFiles });
  });
});

// GET /essay/:folder/:filename
app.get("/essay/:folder/:filename", (req, res) => {
  const { folder, filename } = req.params;
  const essayPath = path.join(__dirname, "uploads", folder, filename);

  if (!fs.existsSync(essayPath)) {
    return res.status(404).json({ error: "Essay file not found" });
  }

  fs.readFile(essayPath, "utf8", (err, content) => {
    if (err) return res.status(500).json({ error: "Failed to read essay file." });

    const assessments = fs.existsSync(assessmentsPath)
      ? JSON.parse(fs.readFileSync(assessmentsPath, "utf-8"))
      : [];

    const assessment = assessments.find(a => a.folder === folder);

    let uploadFolder = folder;
    let baseFilename = filename.replace(".txt", "");
    let imageName = baseFilename + ".png";

    if (assessment) {
      uploadFolder = assessment.folder; // still fallback
    }

    // Try to find actual image name in the upload folder
    const uploadDir = path.join(__dirname, "uploads", uploadFolder);
    const matchingImage = fs.readdirSync(uploadDir).find(
      file => file.startsWith(baseFilename) && /\.(jpg|jpeg|png)$/i.test(file)
    );

    if (matchingImage) {
      imageName = matchingImage;
    }

    res.json({
      content,
      uploadFolder,
      imageName
    });
  });
});

// POST /save-grade

const gradesDir = path.join(__dirname, "data", "grades");

app.post("/save-grade", (req, res) => {
  const { assessmentName, essayFile, grades, comments } = req.body;

  if (!assessmentName || !essayFile || !grades || typeof grades !== "object") {
    return res.status(400).json({ error: "Missing or invalid grading data." });
  }

  const assessmentPath = path.join(gradesDir, assessmentName);
  if (!fs.existsSync(assessmentPath)) {
    fs.mkdirSync(assessmentPath, { recursive: true });
  }

  const gradeFilePath = path.join(assessmentPath, `${essayFile}.json`);
  const gradeData = {
    essayFile,
    grades,
    comments: comments || "",
    gradedAt: new Date().toISOString(),
  };

  fs.writeFile(gradeFilePath, JSON.stringify(gradeData, null, 2), (err) => {
    if (err) {
      console.error("Error saving grade:", err);
      return res.status(500).json({ error: "Failed to save grade." });
    }
    res.status(201).json({ message: "Grade saved successfully." });
  });
});

app.post("/generate-grade", async (req, res) => {
  const { essayText, rubric } = req.body;

  if (!essayText || !rubric || !rubric.criteria) {
    return res.status(400).json({ error: "Essay text and rubric are required." });
  }

  try {
    // Describe criteria with 1–5 scale
    const criteriaDescriptions = rubric.criteria.map((c, i) => {
      return `Criterion ${i + 1}: "${c.title}" — score from 1 to 5`;
    }).join("\n");

    const gradingPrompt = `
You are an AI essay grading assistant.

Given the essay and rubric below, rate each criterion from 1 to 5.
Respond strictly with a JSON object using EXACTLY the original rubric titles as keys (no quotes, no prefixes, no criterion numbers). Example: { "Clarity": 3, "Structure": 4 }
Do NOT include "Criterion 1:" or any prefixes. Use only the rubric titles verbatim.


Essay:
${essayText}

Rubric:
${criteriaDescriptions}
    `.trim();

    const result = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a helpful grading assistant." },
        { role: "user", content: gradingPrompt }
      ],
      temperature: 0.2
    });

    const rawReply = result.choices[0].message.content.trim();
    console.log("GPT raw response:", rawReply);

    // Try to extract JSON from GPT response
    const rawJsonMatch = rawReply.match(/\{[\s\S]*?\}/);
    if (!rawJsonMatch) throw new Error("No valid JSON found in GPT response.");

    const rawScores = JSON.parse(rawJsonMatch[0]);


    const expandedScores = {};

    // Normalize function (lowercase, remove non-alphanumeric)
    const normalizeKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/gi, "");
    const gptKeys = Object.keys(rawScores);

    console.log("Rubric Titles:", rubric.criteria.map(c => c.title));
    console.log("GPT Keys:", gptKeys);

    rubric.criteria.forEach((c) => {
      const expectedKey = normalizeKey(c.title);

      // Find best match from GPT keys
      const matchKey = gptKeys.find(k => normalizeKey(k) === expectedKey);

      if (!matchKey) {
        throw new Error(`Could not match rubric criterion "${c.title}" in GPT response.`);
      }

      const gptScore = rawScores[matchKey];
      const min = c.range[0];
      const max = c.range[1];

      if (typeof gptScore !== "number" || isNaN(gptScore)) {
        throw new Error(`Invalid score for "${c.title}". Got: ${gptScore}`);
      }

      const expanded = ((gptScore - 1) / 4) * (max - min) + min;
      expandedScores[c.title] = Math.round(expanded);
    });


    res.json({
      gptScores: rawScores,
      expanded: expandedScores,
    });

  } catch (err) {
    console.error("Error generating normalized grade:", err);
    res.status(500).json({
      error: err.message || "Failed to generate or normalize grade."
    });
  }
});

// GET /graded-essays/:assessmentName
app.get("/graded-essays/:assessmentName", (req, res) => {
  const dir = path.join(__dirname, "data", "grades", req.params.assessmentName);
  if (!fs.existsSync(dir)) return res.json([]);
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  res.json(files);
});

// GET /grade/:assessmentName/:essayFile
app.get("/grade/:assessmentName/:essayFile", (req, res) => {
  const filePath = path.join(__dirname, "data", "grades", req.params.assessmentName, `${req.params.essayFile}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Grade not found" });

  const raw = fs.readFileSync(filePath, "utf8");
  res.json(JSON.parse(raw));
});







const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
