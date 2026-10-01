import { z } from 'zod';
import { IsoDateSchema } from './common';
import { DisclosurePositionSchema } from './project';

/** Where a take or an export carries C2PA Content Credentials (docs/design/provenance.md#manifests). */
export const ContentCredentialsStampSchema = z.object({
  /** The active manifest's label (`urn:c2pa:…`). */
  manifest: z.string().min(1).max(200),
  /** Common name of the signing certificate. */
  signer: z.string().max(200),
  signedAt: IsoDateSchema,
  /** Ingredients recorded in the manifest (exports: the takes and resources it is made of). */
  ingredients: z.number().int().nonnegative().optional(),
});
export type ContentCredentialsStamp = z.infer<typeof ContentCredentialsStampSchema>;

/** The disclosure label an export was rendered with (docs/design/provenance.md#disclosure-label). */
export const DisclosureStampSchema = z.object({
  label: z.boolean(),
  text: z.string().max(60),
  position: DisclosurePositionSchema,
  reason: z.enum(['policy', 'real_person']).nullable(),
});
export type DisclosureStamp = z.infer<typeof DisclosureStampSchema>;
