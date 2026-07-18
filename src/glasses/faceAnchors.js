// Anatomical reference points, extracted directly from Google's MediaPipe
// canonical_face_model.obj (mediapipe/modules/face_geometry/data). That file
// defines the metric 3D space the FaceLandmarker's facialTransformationMatrix
// operates in: right-handed, centimeters, +X right, +Y up, +Z toward viewer.
//
// Validation: the left/right eye-contour centers below are symmetric around
// x=0 and 6.32cm apart — matching the real-world average human interpupillary
// distance (~6.3cm), confirming these numbers are true-to-scale centimeters.
export const FACE_SPACE_UNITS = 'cm';

export const LEFT_EYE_CENTER = [-3.1601, 2.6431, 3.6261];
export const RIGHT_EYE_CENTER = [3.1601, 2.6431, 3.6261];

// Landmark 33 / 263 — outer eye (canthus) corners. Used for frame width.
export const LEFT_EYE_OUTER = [-4.4459, 2.6640, 3.1734];
export const RIGHT_EYE_OUTER = [4.4459, 2.6640, 3.1734];

// Landmark 133 / 362 — inner eye corners. Used for bridge width.
export const LEFT_EYE_INNER = [-1.8564, 2.5852, 3.7579];
export const RIGHT_EYE_INNER = [1.8564, 2.5852, 3.7579];

// Landmark 6 — glabella / top of nose bridge, where glasses actually rest.
// Notice z=5.79 is well forward of the eyes (z=3.63): the nose bridge
// protrudes toward the camera relative to the eye sockets, as it does
// anatomically. Getting this depth right is what stops glasses floating
// off the face or clipping into it.
export const NOSE_BRIDGE = [0, 2.4733, 5.7886];

// Landmark 197 — lower nose bridge, slightly further down/forward. Used to
// derive the bridge's downward tilt.
export const NOSE_BRIDGE_LOW = [0, 1.7284, 6.3168];

// MediaPipe's default virtual camera (face_geometry/env_generator), which
// FaceLandmarker's facialTransformationMatrix output assumes when unprojecting.
// Matching this exactly is what keeps head pose -> 3D placement bug-free.
export const MEDIAPIPE_CAMERA = {
  verticalFovDegrees: 63.0,
  near: 1,
  far: 10000,
};
