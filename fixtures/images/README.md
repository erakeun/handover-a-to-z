# Synthetic image fixtures

These eight fixtures were created locally for image-attachment validation and review. They contain only generated colored geometric shapes, Korean example labels, and a plain background. They contain no photographs, personal data, user documents, or external assets.

The PNG, JPEG, and WebP variants of each orientation use the same source drawing. All are static RGB images, with no EXIF or custom metadata. Korean text uses the host system Apple SD Gothic Neo font. PNG is lossless; JPEG and WebP are intentionally lossy examples. All fixtures were decoded with Pillow after saving. The two `large-` fixtures exercise DOCX page-fit scaling and portrait aspect-ratio preservation.

| File | Dimensions | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `landscape.png` | 480 × 300 | 9654 | `06a0f1b29906d2855c86e824ed0618771f9d7808276869adf6390d218944e86c` |
| `landscape.jpg` | 480 × 300 | 16328 | `6d5a62459a8c79f05e92a40f922b9fc379f000c0342c5bb6188aea73772c8979` |
| `landscape.webp` | 480 × 300 | 7294 | `4bff650f0de35af7e57c1ac0854f73f057c94bba6d8910e73427119bc8a9bf19` |
| `portrait.png` | 300 × 480 | 9716 | `7896366d2b7d8993486cdb432c90f3e3baf732d843d7df8c0d4acca60b287d0d` |
| `portrait.jpg` | 300 × 480 | 16379 | `f7165a87144a0cf6bf28ee3a92aa90321602491bd60910a0b426c40d627e3299` |
| `portrait.webp` | 300 × 480 | 7114 | `d924f75e8bbc649242acdcb991b99a5c891477ba3e4d59b4b2c9add7685832f9` |
| `large-landscape.png` | 1600 × 900 | 32199 | `4dd7ff460f3f70eba31c39f0273d95a2a138a9eb1fe794b3ef93cbcb5cc58ed8` |
| `large-portrait.jpg` | 900 × 1600 | 68917 | `da48131e8f8cc7d3651a11432f9b56a36d29e3302cfb47468cd2a55b59407218` |
