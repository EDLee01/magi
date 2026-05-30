const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const DATA_FILE = path.join(process.cwd(), "data", "notes.json");

function readNotes() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function addNote(title) {
  const notes = readNotes();
  const note = { id: notes.length + 1, title };
  notes.push(note);
  mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, `${JSON.stringify(notes, null, 2)}\n`, "utf8");
  return note;
}

module.exports = { addNote, readNotes };
