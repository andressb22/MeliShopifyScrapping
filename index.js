import express from "express";
import {runScraping} from "./scrapping.js"
  
const app = express();

app.get("/scrape", async (req, res) => {
  try {
    await runScraping();
    res.json({ ok: true, message: "Scraping ejecutado" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
