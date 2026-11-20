# Camera effect models

The models live in `desktop/ui/public/effects/`. They ship with the app so camera effects work offline and send nothing to Google. Both are MediaPipe models, Apache 2.0.

| File | Source | SHA-256 |
|---|---|---|
| `face_landmarker.task` | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` |
| `selfie_segmenter.tflite` | https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite | `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` |

`faceMesh.ts` comes from MediaPipe's `canonical_face_model.obj` (Apache 2.0).
