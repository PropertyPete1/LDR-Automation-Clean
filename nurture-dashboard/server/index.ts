import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLICKS_FILE_PATH = "/home/ubuntu/fub_automation/data/clicks.json";

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Enable JSON body parsing
  app.use(express.json());

  // Serve static files from dist/public in production
  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  // Serve dynamically generated PDFs directly
  app.use("/pdf", express.static("/home/ubuntu/fub_nurture_dashboard/client/public/pdf"));

  app.use(express.static(staticPath));

  // Custom API Endpoint for tracking Tap-to-Text clicks
  app.post("/api/track-click", async (req, res) => {
    try {
      const { agent, phone, body } = req.body;
      
      if (!agent) {
        res.status(400).json({ error: "Agent name is required" });
        return;
      }

      // Read existing clicks
      let clicks = [];
      try {
        const fileContent = await fs.readFile(CLICKS_FILE_PATH, "utf-8");
        clicks = JSON.parse(fileContent);
      } catch (err) {
        // File doesn't exist or is empty, start with empty array
      }

      // Add new click
      const newClick = {
        timestamp: new Date().toISOString(),
        agent: agent.trim(),
        phone: phone || "",
        body: body || ""
      };
      clicks.push(newClick);

      // Ensure directory exists
      await fs.mkdir(path.dirname(CLICKS_FILE_PATH), { recursive: true });
      
      // Save back to file
      await fs.writeFile(CLICKS_FILE_PATH, JSON.stringify(clicks, null, 2), "utf-8");

      res.status(200).json({ success: true, click: newClick });
    } catch (error) {
      console.error("Failed to track click:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Handle client-side routing - serve index.html for all routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
