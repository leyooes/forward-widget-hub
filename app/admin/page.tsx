"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Shield,
  Loader2,
  ArrowRight,
  AlertCircle,
  Trash2,
  FileCode,
  FileJson,
  Lock,
  UploadCloud,
  RefreshCw,
  Copy,
  Check,
  Key,
  Pencil,
  ImagePlus,
  Plus,
  Globe,
} from "lucide-react";

interface Module {
  id: string;
  filename: string;
  title: string;
  version: string;
  author: string;
  file_size: number;
  is_encrypted: number;
  source_url: string;
}

interface Collection {
  id: string;
  slug: string;
  title: string;
  description: string;
  icon_url: string;
  user_id: string;
  source_url: string;
  created_at: number;
  updated_at: number;
  modules: Module[];
}
