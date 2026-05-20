import { execSync } from "child_process"
const cli = process.argv[1].replace("smoke_cache_test.js", "../dist/cli.js")
const runs = []
for (let i = 0; i < 2; i++) {
  const start = performance.now()
  execSync(`node "${cli}" -p "say hi" -m main --output-format json 2>/dev/null`)
  runs.push(Math.round(performance.now() - start))
}
console.log(runs.join(","))
