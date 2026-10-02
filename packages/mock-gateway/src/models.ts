export type Modality = 'image' | 'video' | 'music';

export interface MockModel {
  id: string;
  modality: Modality;
  limits: Record<string, unknown>;
}

export const MOCK_MODELS: MockModel[] = [
  {
    id: 'mock-image-v1',
    modality: 'image',
    limits: {
      modality: 'image',
      input_modalities: ['text', 'image'],
      supports_image_to_image: true,
      max_input_images: 4,
      max_output_count: 4,
      max_prompt_chars: 32000,
      notes: 'Rideo mock image model: textured frames that copy reference signatures.',
    },
  },
  {
    id: 'mock-video-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'image', 'audio'],
      supports_first_frame: true,
      supports_last_frame: true,
      supports_reference_image: true,
      supports_reference_audio: true,
      supports_reference_video: true,
      max_input_images: 5,
      max_output_count: 1,
      min_duration_seconds: 2,
      max_duration_seconds: 10,
      notes: 'Rideo mock video model: animates the first frame with a slow zoom (H.264 via ffmpeg).',
    },
  },
  {
    id: 'mock-video-lite-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'image'],
      supports_first_frame: true,
      supports_last_frame: false,
      supports_reference_image: true,
      supports_reference_audio: false,
      supports_reference_video: false,
      max_input_images: 3,
      max_output_count: 1,
      min_duration_seconds: 2,
      max_duration_seconds: 10,
      notes: 'Rideo mock video model without audio input: dialogue needs the lip-sync pass.',
    },
  },
  {
    id: 'mock-multishot-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'image'],
      supports_first_frame: true,
      supports_reference_image: true,
      max_input_images: 5,
      max_output_count: 1,
      max_shots: 4,
      min_duration_seconds: 2,
      max_duration_seconds: 20,
      notes: 'Rideo mock multi-shot model: the shots of the prompt as segments separated by hard cuts.',
    },
  },
  {
    id: 'mock-enhance-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'video'],
      supports_reference_video: true,
      supports_upscale: true,
      supports_frame_interpolation: true,
      max_fps: 60,
      max_output_count: 1,
      min_duration_seconds: 1,
      max_duration_seconds: 600,
      notes: 'Rideo mock enhancement model: upscales and interpolates its reference video with ffmpeg.',
    },
  },
  {
    id: 'mock-segment-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'video'],
      supports_reference_video: true,
      supports_segmentation: true,
      max_output_count: 1,
      min_duration_seconds: 1,
      max_duration_seconds: 600,
      notes: 'Rideo mock segmentation model: a matte of the subject (an ellipse in the middle of the frame).',
    },
  },
  {
    id: 'mock-performance-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'image', 'video'],
      supports_first_frame: true,
      supports_reference_video: true,
      supports_performance: true,
      max_output_count: 1,
      min_duration_seconds: 1,
      max_duration_seconds: 10,
      notes:
        'Rideo mock performance model: the first frame with the performance in a corner, for its length.',
    },
  },
  {
    id: 'mock-lipsync-v1',
    modality: 'video',
    limits: {
      modality: 'video',
      input_modalities: ['text', 'video', 'audio'],
      supports_first_frame: false,
      supports_reference_image: false,
      supports_reference_audio: true,
      max_output_count: 1,
      min_duration_seconds: 1,
      max_duration_seconds: 60,
      notes: 'Rideo mock lip-sync model: keeps the reference video and plays the reference audio.',
    },
  },
  {
    id: 'mock-music-v1',
    modality: 'music',
    limits: {
      modality: 'music',
      input_modalities: ['text', 'lyrics'],
      supports_lyrics: true,
      min_duration_seconds: 5,
      max_duration_seconds: 300,
    },
  },
];
