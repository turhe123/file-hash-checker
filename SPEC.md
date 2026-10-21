# File Hash and Checksum Calculator — specification

**Tagline:** Compute MD5, SHA-1, SHA-256 and SHA-512 for text or files in your browser and compare with a known hash.

**Category:** Privacy & Security

**Free alternative to:** Online MD5 and SHA hash generators and file checksum sites (file uploads to compute hash, size limits, ads, MD5 only on many)

**Search phrases:** sha256 checksum, md5 hash generator, file hash checker, verify file checksum online, sha256 online, sha512 generator, compare file hash

**Allowed libraries:** none (browser APIs only)

**Published at:** https://turhe123.github.io/file-hash-checker/

## Acceptance checks (each must have a test)

- hashing the text abc gives SHA-256 ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
- hashing the bundled sample.txt shows MD5, SHA-1, SHA-256 and SHA-512 together
- pasting the correct expected hash shows a green match and a wrong one shows a red mismatch
- the uppercase toggle changes hash letter case
- a file of several MB shows a progress bar and finishes
- works at 390px wide

## Spec

sha256 checksum, md5 hash generator and verify file checksum are routine searches by developers, sysadmins and ordinary people checking a downloaded installer against the published hash. Many online generators upload the file to compute it, which defeats the purpose of verifying something you may not trust, add ads, and limit file size. Others offer only text hashing. A page that hashes a big file locally is more useful and safer.

Our version does one job: compute and verify cryptographic hashes. Features: a Text tab and a File tab, hashing with MD5, SHA-1, SHA-256, SHA-384 and SHA-512 shown together as a result list with copy buttons, an expected hash box that automatically compares against all results and reports which algorithm matched, hex or [removed] output, uppercase toggle, and support for multiple files at once in a results table that can be downloaded as a CSV or a checksum list in the standard two column format used by checksum tools. A note explains that MD5 and SHA-1 are broken for security and fine for detecting accidental corruption.

UI: above the fold a drop zone and a text tab, with a progress bar beneath while hashing. Results appear as a table with algorithm, value and copy button. Beneath is the Compare field with a status chip that says match, no match or waiting. Defaults: all algorithms on, lowercase hex. Empty state shows what to drop. Errors for unreadable files are listed per file. Downloaded list file is named checksums.txt. Keyboard use: Control or Command plus V on the page with focus in the compare field pastes the expected hash and compares immediately.

Technical approach: the SHA family comes from the WebCrypto subtle digest function, which needs the entire data in memory, so for large files hash in chunks. Because subtle digest cannot be streamed, include small hand written incremental implementations of SHA-256 and SHA-512, plus MD5 and SHA-1, and run them in a Web Worker that reads the file in 4 MB slices through the File API, reporting progress. Small inputs under about 64 MB can use the native digest for speed and cross check the worker code in a self test with the known vector for abc. The text tab hashes the UTF-8 bytes and lets the user choose whether a trailing newline is included, since that is the most common source of mismatches. All computing is local with no network access.

Edge cases: files over 2 GB are fine because slices are streamed, but mobile Safari may run out of memory, so keep slice sizes small and warn. Empty files must give the standard empty hashes. Comparison trims whitespace and ignores case and removes any file name that follows the hash in a pasted checksum line. Hex pasted with colons or spaces is normalized. Folders cannot be hashed, so say so if a directory is dropped.

Demo data: a bundled sample.txt holding the fictional line The quick brown fox visits the Maple Street bakery, and the standard test text abc for verifying correctness.
