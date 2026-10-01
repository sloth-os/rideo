import { z } from 'zod';

/**
 * mm-gateway wire types (snake_case, exactly as the public contract / SDK serializes them).
 * Only the members Rideo sends or reads are modelled; responses are parsed leniently (additive contract).
 */
export type GatewayTextPart = { type: 'text'; text: string };
export type GatewayLyricsPart = { type: 'lyrics'; text: string };
export type GatewayImagePart = {
  type: 'image';
  uri: string;
  role?: 'first_frame' | 'last_frame' | 'reference_image';
};
export type GatewayAudioPart = {
  type: 'audio';
  uri: string;
  role?: 'reference_audio' | 'continuation_audio';
};
export type GatewayVideoPart = { type: 'video'; uri: string; role?: 'reference_video' };

export type Dimensions = { width: number; height: number };

export interface GatewayImageRequest {
  model?: string;
  input: (GatewayTextPart | GatewayImagePart)[];
  parameters?: {
    dimensions?: Dimensions;
    seed?: number;
    negative_prompt?: string;
    output_count?: number;
    quality?: string;
    style?: string;
    strength?: number;
    guidance_scale?: number;
    watermark?: boolean;
    delivery?: 'remote' | 'inline';
    file_format?: string;
  };
  routing?: { profile: string };
  metadata?: Record<string, unknown>;
}

export interface GatewayVideoRequest {
  model?: string;
  input: (GatewayTextPart | GatewayImagePart | GatewayAudioPart | GatewayVideoPart)[];
  parameters?: {
    duration_seconds?: number;
    dimensions?: Dimensions;
    fps?: number;
    seed?: number;
    negative_prompt?: string;
    camera_motion?: 'auto' | 'fixed';
    enhance_prompt?: boolean;
    include_audio?: boolean;
    include_last_frame?: boolean;
    watermark?: boolean;
    guidance_scale?: number;
    motion_intensity?: number;
  };
  routing?: { profile: string };
  metadata?: Record<string, unknown>;
}

export interface GatewayMusicRequest {
  model?: string;
  input: (GatewayTextPart | GatewayLyricsPart | GatewayImagePart | GatewayAudioPart)[];
  parameters?: {
    title?: string;
    duration_seconds?: number;
    instrumental?: boolean;
    file_format?: string;
    style?: string;
    bpm?: number;
    seed?: number;
  };
  routing?: { profile: string };
  metadata?: Record<string, unknown>;
}

export const GatewayTaskStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
]);
export type GatewayTaskStatus = z.infer<typeof GatewayTaskStatusSchema>;

export const GatewayTaskSchema = z.looseObject({
  id: z.string(),
  object: z.string().optional(),
  model: z.string().optional().default(''),
  status: GatewayTaskStatusSchema,
  outputs: z
    .array(
      z.looseObject({
        uri: z.string(),
        mime_type: z.string().optional().nullable(),
        cover_uri: z.string().optional().nullable(),
        revised_prompt: z.string().optional().nullable(),
      }),
    )
    .optional()
    .nullable(),
  usage: z.record(z.string(), z.unknown()).optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional().nullable(),
  lyrics: z.string().optional().nullable(),
  created_at: z.string().optional(),
  completed_at: z.string().optional().nullable(),
});
export type GatewayTask = z.infer<typeof GatewayTaskSchema>;

export const TERMINAL_TASK_STATUSES: GatewayTaskStatus[] = ['succeeded', 'failed', 'cancelled', 'expired'];

export const ModelLimitsSchema = z.looseObject({
  modality: z.string().optional(),
  input_modalities: z.array(z.string()).optional(),
  max_prompt_chars: z.number().optional(),
  max_input_images: z.number().optional(),
  max_output_count: z.number().optional(),
  max_duration_seconds: z.number().optional(),
  min_duration_seconds: z.number().optional(),
  supported_sizes: z.array(z.string()).optional(),
  supports_image_to_image: z.boolean().optional(),
  supports_first_frame: z.boolean().optional(),
  supports_last_frame: z.boolean().optional(),
  supports_reference_image: z.boolean().optional(),
  supports_reference_audio: z.boolean().optional(),
  supports_reference_video: z.boolean().optional(),
  supports_audio_output: z.boolean().optional(),
  notes: z.string().optional(),
});
export type ModelLimits = z.infer<typeof ModelLimitsSchema>;

export const ModelLimitsEntrySchema = z.looseObject({
  id: z.string(),
  modality: z.string(),
  limits: ModelLimitsSchema.optional().nullable(),
});
export type ModelLimitsEntry = z.infer<typeof ModelLimitsEntrySchema>;
