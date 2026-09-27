import { describe, expect, it } from "vitest";
import { classifyBashReadOnly } from "../src/gate-prefilter.js";

/**
 * The allowlist's safety property is asymmetric: a wrong "mutating" costs one
 * Jev request, a wrong "read-only" grants silent permission. Every test below
 * therefore asserts the DIRECTION of the answer, and the adversarial block is
 * the important half.
 */
describe("classifyBashReadOnly — reads that must be skipped", () => {
  const allow = [
    "dir /b C:\\tmp\\jev-research\\*.md",
    "cmd /c dir /b C:\\tmp\\jev-research\\*.md",
    'cmd /c "dir C:\\Users\\hoang\\.bun\\install\\global\\node_modules"',
    "grep -n -i -e typesafe /c/Users/hoang/.omp/agent/config.yml",
    "grep -rn -i 'typesafe' /c/a.yml /c/b.yml | head -20",
    "sed -n '100,120p' /c/Users/hoang/.omp/agent/config.yml",
    "gh api repos/tamaratran/fast-jev-compaction",
    'cmd /c "gh api repos/qkal/Canny --jq \\"{{.full_name}}\\""',
    "findstr /N /C:SessionStopEvent src/extensibility/shared-events.ts",
    "curl -sL https://api.github.com/repos/x/y",
    "cat /c/Users/hoang/.omp/agent/config.yml",
    "ls -la /tmp",
    "head -40 file.ts | tail -5",
    "wc -l src/*.ts",
    "git log --oneline -5",
    "git status --short",
    "npm ls --depth=0",
    "which node",
    "grep -o 'pattern' file.ts",
    "rg -o peer@example.com -n src",
  ];
  for (const c of allow) {
    it(`allows: ${c.slice(0, 70)}`, () => {
      expect(classifyBashReadOnly(c)).not.toBeNull();
    });
  }
  it("returns a rule id that names the reason", () => {
    expect(classifyBashReadOnly("grep -n x f.ts")).toMatch(/read-command:grep/);
    expect(classifyBashReadOnly("gh api repos/a/b")).toMatch(/read-subcommand:gh/);
  });
  it("allows a pipe only when every segment is a read", () => {
    expect(classifyBashReadOnly("grep -n x f.ts | head -20")).not.toBeNull();
    expect(classifyBashReadOnly("cat f.ts | tee out.ts")).toBeNull();
  });
});

describe("classifyBashReadOnly — anything that can mutate must go to Jev", () => {
  const deny = [
    // The three that actually mattered: a real delete, hidden in plain sight.
    'cmd /c "del C:\\tmp\\x"',
    "del /s /q C:\\tmp\\x",
    "rm -rf build",
    "Remove-Item -Recurse -Force x",
    // Redirects hide writes.
    "echo hi > file.txt",
    "cat a.txt >> b.txt",
    "grep x f.ts > out.txt",
    // curl that writes.
    "curl -sL https://x -o out.bin",
    "curl -O https://x/y.tgz",
    "wget https://x/y -O out",
    // Code execution: cannot be judged lexically.
    "node -e \"require('fs').unlinkSync('x')\"",
    "python -c \"import os; os.remove('x')\"",
    "bash -c 'rm -rf /'",
    "sh -c 'del x'",
    "pwsh -Command Remove-Item x",
    "powershell -c rm x",
    // Multi-purpose tools on their writing subcommands.
    "git push origin master",
    "git commit -m x",
    "git reset --hard",
    "git clean -fd",
    "git checkout -- .",
    "gh api -X DELETE repos/a/b",
    "gh api -X POST repos/a/b/dispatches",
    "gh pr merge 5",
    "npm install",
    "npm publish",
    "npm run build",
    "pip install requests",
    "sed -i 's/a/b/' f.ts",
    // Sequencing hides a later write.
    "ls && rm -rf x",
    "which node && echo ok",
    "grep x f.ts; rm y",
    // find with an exec action writes through the command it runs.
    "find . -name '*.tmp' -delete",
    "find . -type f -exec rm {} +",
    // Unknown heads are never assumed safe.
    "frobnicate --all",
    "some-tool -x",
    // Empty / whitespace.
    "",
    "   ",
    // A long line can hide a shape; refuse to guess.
    "grep " + "a".repeat(2500),
    // Multi-purpose commands on their writing/executing surface. Each of these
    // was a REAL hole in the first draft of the allowlist: the head looked
    // harmless while the arguments wrote or executed.
    'forfiles /c "cmd /c del C:\\tmp\\x"',
    "certutil -decode in.b64 out.bin",
    "certutil -encode in out",
    "git tag -d v1",
    "git tag v1",
    "git remote remove origin",
    "git remote add evil https://x",
    "git branch -D main",
    "git branch new-branch",
    "git stash",
    "git stash apply",
    // `ps` is not on the allowlist: an unlisted head is denied by default, and
    // that is the intended safe direction rather than an oversight.
    "ps -o pid,comm",
    "git stash pop",
    // Other members of the same class, found by auditing every READ_COMMANDS
    // entry for an argument that changes its meaning.
    "env rm -rf x",
    "env FOO=1 node script.js",
    "hostname evil-name",
    "sort -o out.txt in.txt",
    "sort -oout.txt in.txt",
    "find . -fprint out.txt",
    "file -C -m magic",
    "date -s 2020-01-01",
  ];
  for (const c of deny) {
    it(`denies: ${(c || "(empty)").slice(0, 70)}`, () => {
      expect(classifyBashReadOnly(c)).toBeNull();
    });
  }
});

describe("classifyBashReadOnly — safety invariants", () => {
  it("never returns a truthy value for a non-string", () => {
    expect(classifyBashReadOnly(undefined as unknown as string)).toBeNull();
    expect(classifyBashReadOnly(null as unknown as string)).toBeNull();
    expect(classifyBashReadOnly(42 as unknown as string)).toBeNull();
  });

  it("is case-insensitive about the command head", () => {
    expect(classifyBashReadOnly("DIR /b")).not.toBeNull();
    expect(classifyBashReadOnly("DEL x")).toBeNull();
    expect(classifyBashReadOnly('CMD /C "del x"')).toBeNull();
  });

  it("strips .exe and a directory prefix from the head", () => {
    expect(classifyBashReadOnly("C:\\Windows\\System32\\findstr.exe x y")).not.toBeNull();
    expect(classifyBashReadOnly("/usr/bin/rm x")).toBeNull();
  });
});
