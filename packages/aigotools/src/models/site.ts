import mongoose, { Model } from "mongoose";

import { MongoPlain } from "@/lib/types";
import { ProcessStage, SiteState } from "@/lib/constants";

export interface SiteDocument extends mongoose.Document {
  userId: string;
  url: string;
  siteKey: string;
  featured: boolean;
  name: string;
  snapshot: string;
  desceription: string;
  pricingType: string;
  categories: string[];
  images: string[];
  features: string[];
  usecases: string[];
  users: string[];
  relatedSearchs: string[];
  pricings: string[];
  links: {
    login?: string;
    register?: string;
    documentation?: string;
    pricing?: string;
  };
  voteCount: number;
  metaKeywords: string[];
  metaDesceription: string;
  searchSuggestWords: string[];
  state: SiteState;
  processStage: ProcessStage;
  createdAt: number;
  updatedAt: number;
}

export type Site = MongoPlain<SiteDocument>;

const SiteSchema = new mongoose.Schema<SiteDocument>({
  userId: { type: String, default: "00000000000000000" },
  siteKey: { type: String, required: true, unique: true, index: true },
  url: { type: String, required: true },
  name: { type: String },
  featured: { type: Boolean, default: false },
  snapshot: { type: String, default: "" },
  desceription: { type: String, default: "" },
  pricingType: { type: String, default: "" },
  categories: {
    type: [mongoose.Types.ObjectId],
    ref: "categories",
    index: true,
    default: () => [],
  },
  pricings: { type: [String], default: () => [] },
  images: { type: [String], default: () => [] },
  features: { type: [String], default: () => [] },
  usecases: { type: [String], default: () => [] },
  users: { type: [String], default: () => [] },
  relatedSearchs: { type: [String], default: () => [] },
  links: { type: Object, default: () => ({}) },
  voteCount: { type: Number, default: 0 },
  metaKeywords: { type: [String], default: () => [] },
  metaDesceription: { type: String, default: "" },
  searchSuggestWords: { type: [String], default: () => [] },
  state: {
    type: String,
    enum: Object.values(SiteState),
    default: SiteState.unpublished,
  },
  processStage: {
    type: String,
    enum: Object.values(ProcessStage),
    default: ProcessStage.pending,
  },
  createdAt: {
    type: Number,
    default: () => Date.now(),
  },
  updatedAt: {
    type: Number,
    default: () => Date.now(),
  },
});

export const SiteModel =
  (mongoose.models.sites as Model<SiteDocument>) ||
  mongoose.model<SiteDocument>("sites", SiteSchema, "sites");

SiteSchema.index({
  url: "text",
  name: "text",
  desceription: "text",
  categories: "text",
  features: "text",
  usecases: "text",
  users: "text",
  relatedSearchs: "text",
});

SiteModel.ensureIndexes();