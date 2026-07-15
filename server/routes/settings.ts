import { Router } from "express";
import { loadSettings, saveSettings, validateSettingsPatch, BotSettings } from "../../src/settingsStore.js";

const router = Router();

router.get("/", async (_req, res) => {
  const settings = await loadSettings();
  res.json(settings);
});

router.put("/", async (req, res) => {
  const patch = (req.body ?? {}) as Partial<BotSettings>;
  const validationError = validateSettingsPatch(patch);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const current = await loadSettings();
  const next: BotSettings = {
    ...current,
    ...patch,
    updated_at: Date.now(),
  };
  await saveSettings(next);
  res.json(next);
});

export default router;
