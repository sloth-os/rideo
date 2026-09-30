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
      max_input_images: 5,
      max_output_count: 1,
      min_duration_seconds: 2,
      max_duration_seconds: 10,
      notes: 'Rideo mock video model: animates the first frame with a slow zoom (H.264 via ffmpeg).',
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
