import { describe, expect, it } from "vitest";
import { buildPnms, guessColumn, normalizePhotoUrl, parseCsv, toCsv } from "../src/shared/csv";

describe("parseCsv", () => {
  it("parses plain rows", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("handles quoted commas and escaped quotes", () => {
    expect(parseCsv('a,"b,c","d ""e"""')).toEqual([["a", "b,c", 'd "e"']]);
  });
  it("keeps newlines inside quotes", () => {
    expect(parseCsv('a,"line 1\nline 2"\nb,c')).toEqual([["a", "line 1\nline 2"], ["b", "c"]]);
  });
  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("keeps trailing empty cells", () => {
    expect(parseCsv("a,b,\n1,,\n")).toEqual([["a", "b", ""], ["1", "", ""]]);
  });
  it("strips a BOM", () => {
    expect(parseCsv("﻿name,x\n")).toEqual([["name", "x"]]);
  });
  it("skips fully blank lines", () => {
    expect(parseCsv("a\n\n\nb\n")).toEqual([["a"], ["b"]]);
  });
  it("reads tab-separated text pasted from Google Sheets", () => {
    expect(parseCsv("name\tmajor\nSam\tBiology, CS\n")).toEqual([["name", "major"], ["Sam", "Biology, CS"]]);
  });
  it("does not treat a tab inside a comma CSV as a separator", () => {
    expect(parseCsv("a,b\tc\n")).toEqual([["a", "b\tc"]]);
  });
});

describe("normalizePhotoUrl", () => {
  const thumbnail = "https://drive.google.com/thumbnail?id=abc_123-X&sz=w800";
  it("rewrites /file/d/ID/view links", () => {
    expect(normalizePhotoUrl("https://drive.google.com/file/d/abc_123-X/view?usp=sharing")).toBe(thumbnail);
  });
  it("rewrites open?id= links", () => {
    expect(normalizePhotoUrl("https://drive.google.com/open?id=abc_123-X")).toBe(thumbnail);
  });
  it("rewrites uc?id= links", () => {
    expect(normalizePhotoUrl("https://drive.google.com/uc?export=view&id=abc_123-X")).toBe(thumbnail);
  });
  it("leaves direct URLs alone", () => {
    expect(normalizePhotoUrl("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
  });
  it("uses the first link of a multi-file upload answer", () => {
    expect(normalizePhotoUrl("https://example.com/a.jpg, https://example.com/b.jpg")).toBe("https://example.com/a.jpg");
  });
  it("returns null for blanks and non-URLs", () => {
    expect(normalizePhotoUrl("  ")).toBeNull();
    expect(normalizePhotoUrl("see attached")).toBeNull();
  });
});

describe("guessColumn", () => {
  it("guesses from Google Form headers", () => {
    expect(guessColumn("Timestamp")).toBe("ignore");
    expect(guessColumn("Email Address")).toBe("ignore");
    expect(guessColumn("Full Name")).toBe("name");
    expect(guessColumn("Upload a headshot")).toBe("photo");
    expect(guessColumn("Why do you want to join?")).toBe("question");
  });
  it("ignores blank headers, which cannot be shown as a question", () => {
    expect(guessColumn("  ")).toBe("ignore");
  });
  it("does not mistake a question mentioning names for the name column", () => {
    expect(guessColumn("Name three things you value")).toBe("question");
  });
});

describe("buildPnms", () => {
  it("maps columns, drops empty rows and blank answers", () => {
    const pnms = buildPnms(
      [
        ["Timestamp", "Full Name", "Photo", "Why us?", "Hobbies"],
        ["1/1", "Sam", "https://drive.google.com/file/d/ID1/view", "Brotherhood", ""],
        ["1/2", "", "", "", ""],
        ["1/3", "Alex", "", "Service", "Chess"],
      ],
      ["ignore", "name", "photo", "question", "question"],
    );
    expect(pnms).toEqual([
      {
        name: "Sam",
        photoUrl: "https://drive.google.com/thumbnail?id=ID1&sz=w800",
        answers: [{ q: "Why us?", a: "Brotherhood" }],
      },
      {
        name: "Alex",
        photoUrl: null,
        answers: [
          { q: "Why us?", a: "Service" },
          { q: "Hobbies", a: "Chess" },
        ],
      },
    ]);
  });
});

describe("toCsv", () => {
  it("quotes where needed and neutralizes spreadsheet formulas", () => {
    expect(toCsv([["a,b", 'c"d', 3], ["=SUM(A1)", "ok", 0]])).toBe('"a,b","c""d",3\r\n\'=SUM(A1),ok,0\r\n');
  });
});
