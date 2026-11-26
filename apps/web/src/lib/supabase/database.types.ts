export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          action: string
          actor_type: string
          created_at: string
          details: Json
          entity_id: string | null
          entity_type: string | null
          id: number
        }
        Insert: {
          action: string
          actor_type?: string
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: number
        }
        Update: {
          action?: string
          actor_type?: string
          created_at?: string
          details?: Json
          entity_id?: string | null
          entity_type?: string | null
          id?: number
        }
        Relationships: []
      }
      backup_jobs: {
        Row: {
          attempts: number
          backup_scope: string
          checksum: string | null
          created_at: string
          destination: string | null
          error: Json | null
          finished_at: string | null
          id: string
          manifest: Json | null
          started_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          backup_scope?: string
          checksum?: string | null
          created_at?: string
          destination?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          manifest?: Json | null
          started_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          backup_scope?: string
          checksum?: string | null
          created_at?: string
          destination?: string | null
          error?: Json | null
          finished_at?: string | null
          id?: string
          manifest?: Json | null
          started_at?: string | null
          status?: string
        }
        Relationships: []
      }
      collections: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          name: string
          sort_order: number
          system_key: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name: string
          sort_order?: number
          system_key?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          name?: string
          sort_order?: number
          system_key?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      export_jobs: {
        Row: {
          created_at: string
          error: Json | null
          expires_at: string | null
          finished_at: string | null
          format: string
          id: string
          options: Json
          part_count: number | null
          status: string
          storage_bucket: string | null
          storage_key: string | null
        }
        Insert: {
          created_at?: string
          error?: Json | null
          expires_at?: string | null
          finished_at?: string | null
          format?: string
          id?: string
          options?: Json
          part_count?: number | null
          status?: string
          storage_bucket?: string | null
          storage_key?: string | null
        }
        Update: {
          created_at?: string
          error?: Json | null
          expires_at?: string | null
          finished_at?: string | null
          format?: string
          id?: string
          options?: Json
          part_count?: number | null
          status?: string
          storage_bucket?: string | null
          storage_key?: string | null
        }
        Relationships: []
      }
      favorites: {
        Row: {
          created_at: string
          media_id: string
        }
        Insert: {
          created_at?: string
          media_id: string
        }
        Update: {
          created_at?: string
          media_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "favorites_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: true
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      media: {
        Row: {
          album_group_id: string | null
          album_position: number | null
          created_at: string
          description: string | null
          display_name: string | null
          duration_ms: number | null
          extension: string | null
          filename: string
          fps: number | null
          height: number | null
          id: string
          integrity_status: string
          is_trashed: boolean
          media_type: string
          metadata: Json
          mime_type: string
          original_created_at: string | null
          processing_status: string
          purged_at: string | null
          sha256: string
          size_bytes: number
          source_chat_id: number | null
          source_message_id: number | null
          trashed_at: string | null
          updated_at: string
          uploaded_at: string
          width: number | null
        }
        Insert: {
          album_group_id?: string | null
          album_position?: number | null
          created_at?: string
          description?: string | null
          display_name?: string | null
          duration_ms?: number | null
          extension?: string | null
          filename: string
          fps?: number | null
          height?: number | null
          id?: string
          integrity_status?: string
          is_trashed?: boolean
          media_type: string
          metadata?: Json
          mime_type: string
          original_created_at?: string | null
          processing_status?: string
          purged_at?: string | null
          sha256: string
          size_bytes: number
          source_chat_id?: number | null
          source_message_id?: number | null
          trashed_at?: string | null
          updated_at?: string
          uploaded_at?: string
          width?: number | null
        }
        Update: {
          album_group_id?: string | null
          album_position?: number | null
          created_at?: string
          description?: string | null
          display_name?: string | null
          duration_ms?: number | null
          extension?: string | null
          filename?: string
          fps?: number | null
          height?: number | null
          id?: string
          integrity_status?: string
          is_trashed?: boolean
          media_type?: string
          metadata?: Json
          mime_type?: string
          original_created_at?: string | null
          processing_status?: string
          purged_at?: string | null
          sha256?: string
          size_bytes?: number
          source_chat_id?: number | null
          source_message_id?: number | null
          trashed_at?: string | null
          updated_at?: string
          uploaded_at?: string
          width?: number | null
        }
        Relationships: []
      }
      media_collections: {
        Row: {
          added_at: string
          collection_id: string
          media_id: string
        }
        Insert: {
          added_at?: string
          collection_id: string
          media_id: string
        }
        Update: {
          added_at?: string
          collection_id?: string
          media_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_collections_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_collections_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      media_files: {
        Row: {
          created_at: string
          file_role: string
          id: string
          is_current: boolean
          media_id: string
          mime_type: string
          sha256: string
          size_bytes: number
          storage_bucket: string
          storage_key: string
          version_number: number
        }
        Insert: {
          created_at?: string
          file_role: string
          id?: string
          is_current?: boolean
          media_id: string
          mime_type: string
          sha256: string
          size_bytes: number
          storage_bucket: string
          storage_key: string
          version_number?: number
        }
        Update: {
          created_at?: string
          file_role?: string
          id?: string
          is_current?: boolean
          media_id?: string
          mime_type?: string
          sha256?: string
          size_bytes?: number
          storage_bucket?: string
          storage_key?: string
          version_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "media_files_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      media_tags: {
        Row: {
          added_at: string
          media_id: string
          tag_id: string
        }
        Insert: {
          added_at?: string
          media_id: string
          tag_id: string
        }
        Update: {
          added_at?: string
          media_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_tags_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      media_versions: {
        Row: {
          created_at: string
          id: string
          media_id: string
          prior_file_id: string
          reason: string
          replaced_by_file_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          media_id: string
          prior_file_id: string
          reason?: string
          replaced_by_file_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          media_id?: string
          prior_file_id?: string
          reason?: string
          replaced_by_file_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "media_versions_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_versions_prior_file_id_fkey"
            columns: ["prior_file_id"]
            isOneToOne: false
            referencedRelation: "media_files"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_versions_replaced_by_file_id_fkey"
            columns: ["replaced_by_file_id"]
            isOneToOne: false
            referencedRelation: "media_files"
            referencedColumns: ["id"]
          },
        ]
      }
      owner_settings: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          settings: Json
          telegram_chat_id: number | null
          telegram_user_id: number
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          settings?: Json
          telegram_chat_id?: number | null
          telegram_user_id: number
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          settings?: Json
          telegram_chat_id?: number | null
          telegram_user_id?: number
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      processing_jobs: {
        Row: {
          attempts: number
          available_at: string
          created_at: string
          error: Json | null
          finished_at: string | null
          heartbeat_at: string | null
          id: string
          idempotency_key: string
          job_type: string
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          media_id: string | null
          payload: Json
          priority: number
          result: Json | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          available_at?: string
          created_at?: string
          error?: Json | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          idempotency_key: string
          job_type: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          media_id?: string | null
          payload?: Json
          priority?: number
          result?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          available_at?: string
          created_at?: string
          error?: Json | null
          finished_at?: string | null
          heartbeat_at?: string | null
          id?: string
          idempotency_key?: string
          job_type?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          media_id?: string | null
          payload?: Json
          priority?: number
          result?: Json | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "processing_jobs_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          created_at: string
          id: string
          ip_hash: string | null
          last_seen_at: string
          revoked_at: string | null
          telegram_user_id: number
          token_hash: string
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          ip_hash?: string | null
          last_seen_at?: string
          revoked_at?: string | null
          telegram_user_id: number
          token_hash: string
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          ip_hash?: string | null
          last_seen_at?: string
          revoked_at?: string | null
          telegram_user_id?: number
          token_hash?: string
          user_agent?: string | null
        }
        Relationships: []
      }
      tags: {
        Row: {
          color: string | null
          created_at: string
          id: string
          name: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          id?: string
          name: string
        }
        Update: {
          color?: string | null
          created_at?: string
          id?: string
          name?: string
        }
        Relationships: []
      }
      telegram_deliveries: {
        Row: {
          created_at: string
          delivery_mode: string
          error: Json | null
          id: string
          media_id: string
          sent_at: string | null
          status: string
          telegram_chat_id: number
          telegram_message_id: number | null
        }
        Insert: {
          created_at?: string
          delivery_mode: string
          error?: Json | null
          id?: string
          media_id: string
          sent_at?: string | null
          status?: string
          telegram_chat_id: number
          telegram_message_id?: number | null
        }
        Update: {
          created_at?: string
          delivery_mode?: string
          error?: Json | null
          id?: string
          media_id?: string
          sent_at?: string | null
          status?: string
          telegram_chat_id?: number
          telegram_message_id?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "telegram_deliveries_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_jobs: {
        Row: {
          attempts: number
          created_at: string
          error: Json | null
          id: string
          job_type: string
          max_attempts: number
          media_id: string | null
          payload: Json
          sequence_no: number
          status: string
          telegram_chat_id: number | null
          telegram_message_id: number | null
          telegram_update_id: number | null
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          error?: Json | null
          id?: string
          job_type: string
          max_attempts?: number
          media_id?: string | null
          payload?: Json
          sequence_no?: number
          status?: string
          telegram_chat_id?: number | null
          telegram_message_id?: number | null
          telegram_update_id?: number | null
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          error?: Json | null
          id?: string
          job_type?: string
          max_attempts?: number
          media_id?: string | null
          payload?: Json
          sequence_no?: number
          status?: string
          telegram_chat_id?: number | null
          telegram_message_id?: number | null
          telegram_update_id?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "telegram_jobs_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
