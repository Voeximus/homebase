// ── The pinned weights ───────────────────────────────────────────────────────
//
// Rule 5 promises "same photo in, same answer out", and that promise is only as
// good as the certainty that the model file loaded today is the one measured
// yesterday. So every file the reader loads is listed here with its SHA-256, the
// loader refuses a file that does not match, and OCR_ENGINE is derived from the
// recognition model's hash — a label saved with an engine string can always be
// traced to the exact bytes that read it.
//
// Source: the official PaddlePaddle ONNX exports on Hugging Face (Apache-2.0),
// pinned to a commit rather than "main":
//   det.onnx  PaddlePaddle/PP-OCRv6_tiny_det_onnx @ 2ba1506c0380b8f0b03dd142459aac66d4421f6c  inference.onnx
//   rec.onnx  PaddlePaddle/PP-OCRv6_tiny_rec_onnx @ 2612ab37152ae0a677521bae4e1e3d4fb4cf7c30  inference.onnx
//   dict.json the character_dict list from that same rec commit's inference.yml
//             (6,904 characters: ASCII, Latin-1 symbols, CJK, full-width forms),
//             re-encoded as a JSON array because the list contains U+3000, an
//             ideographic space that a line-based text file would silently trim.
// See public/models/pp-ocrv6-tiny/NOTICE for attribution.
//
// The runtime is pinned too: onnxruntime-web is an exact version in
// package.json, and its .wasm is hashed at build time by Vite's asset naming.

export const MODEL_DIR = "models/pp-ocrv6-tiny/";

export const MODEL_FILES = {
  det: { file: "det.onnx", bytes: 1_780_590, sha256: "193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8" },
  rec: { file: "rec.onnx", bytes: 4_462_639, sha256: "9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6" },
  dict: { file: "dict.json", bytes: 47_870, sha256: "b9bf03b8b02c9c22f6af847769269d5c1f877cfc8914bbaecac6a44d7a6061de" },
} as const;

export type ModelFile = keyof typeof MODEL_FILES;

/** "pp-ocrv6-tiny@" + the first 12 hex digits of rec.onnx's SHA-256. */
export const OCR_ENGINE = `pp-ocrv6-tiny@${MODEL_FILES.rec.sha256.slice(0, 12)}`;
