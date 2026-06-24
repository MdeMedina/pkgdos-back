import { Response, Request } from "express";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../config/database.js";
import { env } from "../config/env.js";
import { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { AssetType, VectorizationStatus } from "@prisma/client";


export class KnowledgeController {
  // Get knowledge assets by brand
  static async listByBrand(req: AuthenticatedRequest, res: Response) {
    try {
      const { brand_id } = req.params;
      const assets = await prisma.knowledgeAsset.findMany({
        // Only APPROVED assets surface in the brand knowledge base. Proposals (status='Proposed') stay hidden.
        where: { brand_id, status: "Active" },
        include: {
          department: true,
          department_role: true,
        },
        orderBy: { created_at: "desc" },
      });
      return res.status(200).json(assets);
    } catch (error) {
      console.error("List knowledge by brand error:", error);
      return res.status(500).json({ message: "Failed to list brand assets" });
    }
  }

  // Get knowledge assets by department
  static async listByDepartment(req: AuthenticatedRequest, res: Response) {
    try {
      const { department_id } = req.params;
      const assets = await prisma.knowledgeAsset.findMany({
        where: { department_id, status: "Active" },
        include: {
          department: true,
          department_role: true,
        },
        orderBy: { created_at: "desc" },
      });
      return res.status(200).json(assets);
    } catch (error) {
      console.error("List knowledge by department error:", error);
      return res.status(500).json({ message: "Failed to list department assets" });
    }
  }

  // Get all knowledge assets (admin only)
  static async listAll(req: AuthenticatedRequest, res: Response) {
    try {
      const assets = await prisma.knowledgeAsset.findMany({
        include: {
          department: true,
          department_role: true,
        },
        orderBy: { created_at: "desc" },
      });
      return res.status(200).json(assets);
    } catch (error) {
      console.error("List all knowledge assets error:", error);
      return res.status(500).json({ message: "Failed to list knowledge assets" });
    }
  }

  // Upload file to pipeline
  static async upload(req: AuthenticatedRequest, res: Response) {
    try {
      const file = req.file;
      const { brand_id, asset_type, title, department_id, department_role_id } = req.body;

      if (!file) {
        return res.status(400).json({ message: "No document file was uploaded" });
      }
      const isExternal = asset_type === "External";
      if (!asset_type) {
        fs.unlinkSync(file.path);
        return res.status(400).json({ message: "Asset Type is required" });
      }
      if (!isExternal && !brand_id && !department_id) {
        // Cleanup uploaded file if request is bad
        fs.unlinkSync(file.path);
        return res.status(400).json({ message: "Brand ID or Department ID is required for non-External assets" });
      }

      // Enforce that brand documents are strictly not associated with any department,
      // and department documents are strictly not associated with any brand.
      // And external documents are completely global (no brand, no department).
      const finalBrandId = isExternal ? null : (brand_id ? brand_id : null);
      const finalDeptId = isExternal ? null : (brand_id ? null : (department_id || null));
      const finalRoleId = isExternal ? null : (brand_id ? null : (department_role_id || null));

      let assetId: string;
      let asset: any;

      if (env.N8N_BASE_URL) {
        const ingestUrl = `${env.N8N_BASE_URL}/webhook/ingest-document`;
        console.log(`Notifying n8n at: ${ingestUrl}`);
        
        // Construct dynamic absolute URL and callback URL
        const protocol = req.protocol;
        const host = req.get("host");
        const fileUrl = `${protocol}://${host}/uploads/${file.filename}`;
        const callbackUrl = `${protocol}://${host}/api/knowledge/callback`;

        const n8nResponse = await fetch(ingestUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-n8n-token": env.N8N_SECRET_TOKEN,
          },
          body: JSON.stringify({
            brand_id: finalBrandId,
            title: title || file.originalname,
            asset_type,
            source_file_url: fileUrl,
            callback_url: callbackUrl,
            department_id: finalDeptId,
            department_role_id: finalRoleId,
          }),
        });

        if (!n8nResponse.ok) {
          const errMsg = `n8n webhook failed with status ${n8nResponse.status}`;
          console.error(errMsg);
          fs.unlinkSync(file.path);
          return res.status(500).json({ message: errMsg });
        }

        const data = (await n8nResponse.json()) as { job_id: string; knowledge_asset_id: string; status: string };
        assetId = data.knowledge_asset_id;

        asset = {
          id: assetId,
          brand_id: finalBrandId,
          title: title || file.originalname,
          asset_type,
          status: "Active",
          source_file_url: `/uploads/${file.filename}`, // Return relative path for frontend download API to read locally
          pgvector_ref_id: null,
          vectorization_status: "Pending",
          percent: 0.0,
          department_id: finalDeptId,
          department_role_id: finalRoleId,
          created_at: new Date(),
        };
      } else {
        console.warn("N8N_INTAKE_WEBHOOK is not defined. Falling back to local mock simulation.");
        
        // Under fallback mock simulation, we insert it manually and simulate progress
        const localAsset = await prisma.knowledgeAsset.create({
          data: {
            brand_id: finalBrandId,
            title: title || file.originalname,
            asset_type: asset_type as AssetType,
            status: "Active",
            source_file_url: `/uploads/${file.filename}`,
            vectorization_status: "Pending",
            percent: 0.0,
            department_id: finalDeptId,
            department_role_id: finalRoleId,
          },
          include: {
            department: true,
            department_role: true,
          }
        });

        assetId = localAsset.id;
        asset = localAsset;

        setTimeout(async () => {
          try {
            await prisma.knowledgeAsset.update({
              where: { id: assetId },
              data: {
                vectorization_status: "Embedded",
                pgvector_ref_id: `pg_vec_${assetId.substring(0, 8)}`,
                percent: 100.0,
              },
            });
            console.log(`Pipeline mock finished. KnowledgeAsset ${assetId} status transitioned to Embedded.`);
          } catch (e) {
            console.error("Mock embedding simulator failed:", e);
          }
        }, 5000);
      }

      return res.status(201).json(asset);
    } catch (error) {
      console.error("Upload knowledge asset error:", error);
      return res.status(500).json({ message: "Failed to upload and ingest document" });
    }
  }

  // Ingest progress callback (n8n Webhook)
  static async callback(req: Request, res: Response) {
    try {
      const { knowledge_asset_id, status, percent } = req.body;

      if (!knowledge_asset_id) {
        return res.status(400).json({ message: "knowledge_asset_id is required" });
      }

      const existing = await prisma.knowledgeAsset.findUnique({ where: { id: knowledge_asset_id } });
      if (!existing) {
        console.warn(`[Callback] Knowledge asset not found: ${knowledge_asset_id}`);
        return res.status(404).json({ message: "Knowledge asset not found" });
      }

      let vectorization_status: VectorizationStatus = "Pending";
      let finalPercent = percent !== undefined ? parseFloat(percent) : 0;

      if (status === "completed") {
        vectorization_status = "Embedded";
        finalPercent = 100;
      } else if (status === "error") {
        vectorization_status = "Error";
      }

      const asset = await prisma.knowledgeAsset.update({
        where: { id: knowledge_asset_id },
        data: {
          vectorization_status,
          percent: finalPercent,
        },
      });

      console.log(`[Callback] Asset ${knowledge_asset_id} updated: status=${vectorization_status}, percent=${finalPercent}%`);

      return res.status(200).json(asset);
    } catch (error) {
      console.error("Knowledge status callback error:", error);
      return res.status(500).json({ message: "Failed to update vectorization progress" });
    }
  }

  // Transition vectorization status callback (n8n Webhook)
  static async statusWebhook(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { vectorization_status, pgvector_ref_id } = req.body;

      if (!vectorization_status) {
        return res.status(400).json({ message: "Vectorization status is required" });
      }

      const existing = await prisma.knowledgeAsset.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Knowledge asset not found" });
      }

      const asset = await prisma.knowledgeAsset.update({
        where: { id },
        data: {
          vectorization_status: vectorization_status as VectorizationStatus,
          pgvector_ref_id: pgvector_ref_id || existing.pgvector_ref_id,
        },
      });

      return res.status(200).json(asset);
    } catch (error) {
      console.error("Knowledge status webhook error:", error);
      return res.status(500).json({ message: "Failed to update vectorization status" });
    }
  }

  // List PENDING proposals (status='Proposed') for admin review. Optional ?type=Gold|Jewel & ?brand_id=
  static async listProposals(req: AuthenticatedRequest, res: Response) {
    try {
      const { type, brand_id } = req.query as { type?: string; brand_id?: string };
      const where: any = { status: "Proposed" };
      if (type === "Gold" || type === "Jewel") where.asset_type = type as AssetType;
      if (brand_id) where.brand_id = brand_id;

      const proposals = await prisma.knowledgeAsset.findMany({
        where,
        include: { brand: true, department: true, department_role: true },
        orderBy: { created_at: "desc" },
      });
      return res.status(200).json(proposals);
    } catch (error) {
      console.error("List proposals error:", error);
      return res.status(500).json({ message: "Failed to list proposals" });
    }
  }

  // Admin approves a proposal -> triggers the n8n approval flow (promotes to Active, generates docx, etc.)
  static async approve(req: AuthenticatedRequest, res: Response) {
    try {
      const { id } = req.params;
      const existing = await prisma.knowledgeAsset.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({ message: "Knowledge asset not found" });
      }
      if (existing.status !== "Proposed") {
        return res.status(409).json({ message: `Asset is not a pending proposal (status='${existing.status}')` });
      }

      // Hand off to n8n: it flips status to Active and asks the backend to generate the .docx.
      const approveUrl = `${env.N8N_BASE_URL}/webhook/pkgd/approve-asset`;
      let n8nResult: unknown = null;
      try {
        const r = await fetch(approveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-n8n-token": env.N8N_SECRET_TOKEN },
          body: JSON.stringify({ asset_id: id, approved_by: req.user?.id ?? null }),
        });
        if (!r.ok) {
          const txt = await r.text();
          console.error(`n8n approve webhook failed (${r.status}): ${txt}`);
          return res.status(502).json({ message: "Approval workflow failed", detail: txt });
        }
        n8nResult = await r.json().catch(() => null);
      } catch (e) {
        console.error("Failed to reach n8n approve webhook:", e);
        return res.status(502).json({ message: "Could not reach approval workflow" });
      }

      return res.status(200).json({ ok: true, asset_id: id, result: n8nResult });
    } catch (error) {
      console.error("Approve asset error:", error);
      return res.status(500).json({ message: "Failed to approve asset" });
    }
  }

  // Generate a .docx of the concept and store it in uploads (multer dir). Called by n8n (requireN8N).
  static async generateDoc(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const asset = await prisma.knowledgeAsset.findUnique({
        where: { id },
        include: { chunks: { orderBy: { id: "asc" } }, brand: true },
      });
      if (!asset) {
        return res.status(404).json({ message: "Knowledge asset not found" });
      }

      const concept = asset.chunks.map((c) => c.content).join("\n\n").trim();
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");

      const bodyParagraphs = (concept || "Sin contenido.")
        .split(/\n{2,}/)
        .map((block) =>
          new Paragraph({
            children: block.split("\n").map((line, i) =>
              new TextRun({ text: line, break: i > 0 ? 1 : undefined })
            ),
          })
        );

      const doc = new Document({
        sections: [
          {
            children: [
              new Paragraph({ text: asset.title, heading: HeadingLevel.HEADING_1 }),
              new Paragraph({
                children: [
                  new TextRun({ italics: true, text: `${asset.asset_type} · ${asset.brand?.name ?? "Sin marca"}` }),
                ],
              }),
              new Paragraph({ text: "" }),
              ...bodyParagraphs,
            ],
          },
        ],
      });

      const buffer = await Packer.toBuffer(doc);
      const safe = asset.title.replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 60) || "concepto";
      const filename = `${Date.now()}-${safe}.docx`;
      if (!fs.existsSync(env.UPLOADS_DIR)) fs.mkdirSync(env.UPLOADS_DIR, { recursive: true });
      fs.writeFileSync(path.join(env.UPLOADS_DIR, filename), buffer);

      const source_file_url = `/uploads/${filename}`;
      const updated = await prisma.knowledgeAsset.update({
        where: { id },
        data: { source_file_url },
      });

      return res.status(200).json({ ok: true, source_file_url, asset: updated });
    } catch (error) {
      console.error("Generate doc error:", error);
      return res.status(500).json({ message: "Failed to generate document" });
    }
  }

  // Admin approves the Gold PROPOSAL produced by a session (replaces the legacy direct extractGold).
  // Resolves the pending proposal (status='Proposed') linked to the session and hands off to the n8n
  // approval flow, which promotes it to Active, marks the session, and generates the .docx.
  static async approveBySession(req: AuthenticatedRequest, res: Response) {
    try {
      const { session_id } = req.params;

      const proposal = await prisma.knowledgeAsset.findFirst({
        where: { source_session_id: session_id, status: "Proposed", asset_type: "Gold" },
        orderBy: { created_at: "desc" },
      });
      if (!proposal) {
        return res.status(409).json({ message: "No pending Gold proposal for this session" });
      }

      const approveUrl = `${env.N8N_BASE_URL}/webhook/pkgd/approve-asset`;
      let n8nResult: unknown = null;
      try {
        const r = await fetch(approveUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-n8n-token": env.N8N_SECRET_TOKEN },
          body: JSON.stringify({ asset_id: proposal.id, approved_by: req.user?.id ?? null }),
        });
        if (!r.ok) {
          const txt = await r.text();
          console.error(`n8n approve webhook failed (${r.status}): ${txt}`);
          return res.status(502).json({ message: "Approval workflow failed", detail: txt });
        }
        n8nResult = await r.json().catch(() => null);
      } catch (e) {
        console.error("Failed to reach n8n approve webhook:", e);
        return res.status(502).json({ message: "Could not reach approval workflow" });
      }

      return res.status(200).json({ ok: true, asset_id: proposal.id, result: n8nResult });
    } catch (error) {
      console.error("Approve gold by session error:", error);
      return res.status(500).json({ message: "Failed to approve session gold" });
    }
  }

  // Stream physical document file download
  static async download(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const asset = await prisma.knowledgeAsset.findUnique({ where: { id } });
      if (!asset) {
        return res.status(404).json({ message: "Knowledge asset not found" });
      }

      // If it is an extracted gold asset, stream the JSON transcript as text
      if (asset.asset_type === "Gold" && asset.source_session_id) {
        const session = await prisma.session.findUnique({
          where: { id: asset.source_session_id },
          select: { transcript_payload: true },
        });
        
        const payload = session?.transcript_payload ? JSON.stringify(session.transcript_payload, null, 2) : "[]";
        res.setHeader("Content-Disposition", `attachment; filename="${asset.title}.txt"`);
        res.setHeader("Content-Type", "text/plain");
        return res.send(payload);
      }

      if (!asset.source_file_url) {
        return res.status(404).json({ message: "No source file available for this asset" });
      }

      const filename = path.basename(asset.source_file_url);
      const filePath = path.join(env.UPLOADS_DIR, filename);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ message: "Physical file does not exist on disk" });
      }

      res.setHeader("Content-Disposition", `attachment; filename="${asset.title}${path.extname(filename)}"`);
      return res.sendFile(filePath);
    } catch (error) {
      console.error("Download asset error:", error);
      return res.status(500).json({ message: "Failed to download document" });
    }
  }

  // Delete document (and physically from server, cascading doc chunks)
  static async delete(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const asset = await prisma.knowledgeAsset.findUnique({ where: { id } });
      
      if (!asset) {
        return res.status(404).json({ message: "Knowledge asset not found" });
      }

      // 1. If physical file exists, delete it from disk
      if (asset.source_file_url) {
        // Skip mock files
        if (!asset.source_file_url.startsWith("/mock/")) {
          const filename = path.basename(asset.source_file_url);
          const filePath = path.join(env.UPLOADS_DIR, filename);
          
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              console.log(`Physically unlinked file from server: ${filePath}`);
            }
          } catch (err) {
            console.error(`Failed to physically delete file at ${filePath}:`, err);
            // Non-blocking: we still want to delete the db records even if the physical file deletion fails
          }
        }
      }

      // 2. Delete the db record (will cascade-delete document_chunks & ingestion_jobs)
      await prisma.knowledgeAsset.delete({ where: { id } });
      console.log(`Deleted knowledge asset and all related database records for: ${id}`);

      return res.status(200).json({ message: "Knowledge asset deleted successfully" });
    } catch (error) {
      console.error("Delete asset error:", error);
      return res.status(500).json({ message: "Failed to delete knowledge asset" });
    }
  }

  // Update brand association
  static async updateBrand(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { brand_id } = req.body;

      if (!brand_id) {
        return res.status(400).json({ message: "Brand ID is required" });
      }

      // Verify brand exists
      const brand = await prisma.brand.findUnique({ where: { id: brand_id } });
      if (!brand) {
        return res.status(404).json({ message: "Target brand not found" });
      }

      const updated = await prisma.knowledgeAsset.update({
        where: { id },
        data: { brand_id },
      });

      console.log(`Reassigned knowledge asset ${id} to brand ${brand_id}`);
      return res.status(200).json(updated);
    } catch (error) {
      console.error("Update asset brand error:", error);
      return res.status(500).json({ message: "Failed to update asset brand" });
    }
  }

  // Get all external knowledge assets
  static async listExternal(req: AuthenticatedRequest, res: Response) {
    try {
      const assets = await prisma.knowledgeAsset.findMany({
        where: {
          asset_type: "External",
        },
        orderBy: { created_at: "desc" },
      });
      return res.status(200).json(assets);
    } catch (error) {
      console.error("List external assets error:", error);
      return res.status(500).json({ message: "Failed to list external assets" });
    }
  }
}
