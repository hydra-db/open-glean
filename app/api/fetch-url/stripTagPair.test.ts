/**
 * Tag stripping must stay linear.
 *
 * The regexes this replaced used a lazy `[\s\S]*?` to span an opening and a
 * closing tag. When the closing tag is absent, that backtracks quadratically:
 * a 1.7 MB page of repeated `<script` openers blocked the event loop for 82
 * seconds. Node runs one thread, so that stalls every other request, and an
 * unauthenticated caller chooses the page.
 */
import { describe, expect, it } from "vitest";
import { stripTagPair } from "./route";

describe("stripTagPair", () => {
  it("removes a tag and its contents", () => {
    expect(stripTagPair("a<script>evil()</script>b", "script")).toBe("a b");
  });

  it("removes several occurrences", () => {
    expect(stripTagPair("<script>x</script>mid<script>y</script>", "script")).toBe(
      " mid ",
    );
  });

  it("matches regardless of case", () => {
    expect(stripTagPair("a<SCRIPT>x</SCRIPT>b", "script")).toBe("a b");
  });

  it("handles attributes on the opening tag", () => {
    expect(stripTagPair('a<script type="text/js">x</script>b', "script")).toBe("a b");
  });

  it("drops everything after an unterminated opener", () => {
    // A browser treats the rest of the document as script content too.
    expect(stripTagPair("keep<script>never ends", "script")).toBe("keep");
  });

  it("leaves text without the tag untouched", () => {
    expect(stripTagPair("plain text", "script")).toBe("plain text");
  });

  it("handles an empty string", () => {
    expect(stripTagPair("", "script")).toBe("");
  });

  it("stays fast on the input that used to freeze the server", () => {
    // 400k characters of openers with no closer: the exact attack shape.
    const attack = "<script".repeat(60_000);
    const started = Date.now();
    stripTagPair(attack, "script");
    const elapsed = Date.now() - started;
    // The old regex took tens of seconds on this. Anything near a second means
    // the quadratic behaviour is back.
    expect(elapsed).toBeLessThan(1000);
  });

  it("stays fast on many complete pairs", () => {
    const many = "<script>x</script>".repeat(20_000);
    const started = Date.now();
    stripTagPair(many, "script");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("stripTagPair — does not over-strip", () => {
  it("leaves an unrelated tag that starts with the same letters", () => {
    // <scripting> is not <script>; the page must survive.
    expect(stripTagPair("<scripting>x</scripting>keep", "script")).toBe(
      "<scripting>x</scripting>keep",
    );
  });

  it("accepts a closing tag with whitespace before the bracket", () => {
    // Browsers accept </script > and </script\n> as valid closers.
    expect(stripTagPair("a<script>x</script >b", "script")).toBe("a b");
    expect(stripTagPair("a<script>x</script\n>b", "script")).toBe("a b");
  });

  it("keeps text after a legitimately closed tag", () => {
    expect(stripTagPair("<script>x</script ><p>keep</p>", "script")).toBe(
      " <p>keep</p>",
    );
  });

  it("matches an opener that ends the name with a slash or bracket", () => {
    expect(stripTagPair("a<script/>b", "script")).not.toContain("script/");
    expect(stripTagPair("a<script>x</script>b", "script")).toBe("a b");
  });
});
