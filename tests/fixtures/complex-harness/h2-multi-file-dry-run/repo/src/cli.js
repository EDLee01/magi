#!/usr/bin/env node

const { addNote, readNotes } = require("./store");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--title") {
      options.title = rest[index + 1];
      index += 1;
    }
  }
  return { command, options };
}

function help() {
  return [
    "Usage:",
    "  node src/cli.js add --title <title>",
    "  node src/cli.js list"
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === "add") {
    if (!options.title) {
      console.error(help());
      return 1;
    }
    const note = addNote(options.title);
    console.log(`Added note #${note.id}: ${note.title}`);
    return 0;
  }
  if (command === "list") {
    const notes = readNotes();
    for (const note of notes) {
      console.log(`#${note.id} ${note.title}`);
    }
    return 0;
  }
  console.error(help());
  return 1;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main, parseArgs, help };
