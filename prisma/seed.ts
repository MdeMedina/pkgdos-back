import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting DB seeding...");

  // Clean old data (in reverse order of dependencies)
  await prisma.userBrand.deleteMany({});
  await prisma.documentChunk.deleteMany({});
  await prisma.knowledgeAsset.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.brand.deleteMany({});
  await prisma.user.deleteMany({});

  const passwordHash = bcrypt.hashSync("admin", 10);
  const operatorPasswordHash = bcrypt.hashSync("operator123", 10);

  // 1. Seed Brands
  const vertebraBrand = await prisma.brand.create({
    data: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Vértebra Studio",
      industry: "Industrial Design",
      status: "Active",
    },
  });

  const halconBrand = await prisma.brand.create({
    data: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Halcón Capital",
      industry: "Private Equity",
      status: "Active",
    },
  });

  const nodoBrand = await prisma.brand.create({
    data: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Nodo Forge",
      industry: "Industrial Manufacturing",
      status: "Paused",
    },
  });

  console.log("Brands seeded.");

  // 2. Seed Users
  const adminUser = await prisma.user.create({
    data: {
      id: "a0000000-0000-4000-8000-000000000001",
      full_name: "Directorate General",
      email: "admin@pkgd.os",
      password_hash: passwordHash,
      global_role: "admin",
      session_token_n8n: "n8n.token.admin123",
      friction_level: 0.0,
      calcification_level: 0.0,
    },
  });

  const helenaUser = await prisma.user.create({
    data: {
      id: "b0000000-0000-4000-8000-000000000002",
      full_name: "Helena Ruiz",
      email: "helena.ruiz@pkgd.os",
      password_hash: operatorPasswordHash,
      global_role: "operator",
      session_token_n8n: "n8n.token.helena123",
      friction_level: 62.0,
      calcification_level: 34.0,
    },
  });

  const marcoUser = await prisma.user.create({
    data: {
      id: "c0000000-0000-4000-8000-000000000003",
      full_name: "Marco Petrov",
      email: "marco.petrov@pkgd.os",
      password_hash: operatorPasswordHash,
      global_role: "operator",
      session_token_n8n: "n8n.token.marco123",
      friction_level: 81.0,
      calcification_level: 58.0,
    },
  });

  const anaUser = await prisma.user.create({
    data: {
      id: "d0000000-0000-4000-8000-000000000004",
      full_name: "Ana Volkov",
      email: "ana.volkov@pkgd.os",
      password_hash: operatorPasswordHash,
      global_role: "operator",
      session_token_n8n: "n8n.token.ana123",
      friction_level: 24.0,
      calcification_level: 12.0,
    },
  });


  console.log("Users seeded.");

  // 3. Link Operators to Brands
  await prisma.userBrand.createMany({
    data: [
      { user_id: helenaUser.id, brand_id: vertebraBrand.id },
      { user_id: marcoUser.id, brand_id: halconBrand.id },
      { user_id: anaUser.id, brand_id: vertebraBrand.id },
      { user_id: anaUser.id, brand_id: halconBrand.id },
    ],
  });

  console.log("User-Brand mappings seeded.");

  // 4. Seed Mock Sessions to keep history working
  const sampleThread = [
    { id: "m1", role: "user", text: "Propose: cut launch budget 18% to fund a parallel R&D track.", ts: "2026-05-20T09:01:00Z" },
    {
      id: "m2",
      role: "ai-ceo",
      text: "Define the parallel track first. A budget cut isn't a thesis — it's an aftermath. What is the bet you are unwilling to lose?",
      ts: "2026-05-20T09:01:08Z",
    },
    {
      id: "m3",
      role: "user",
      text: "The bet is a closed-loop manufacturing prototype by Q3.",
      ts: "2026-05-20T09:02:30Z",
    },
    {
      id: "m4",
      role: "ai-ceo",
      text: "Then the launch isn't the variable. The variable is who runs the prototype. Name them. Out loud.",
      ts: "2026-05-20T09:02:42Z",
    },
  ];

  const session1 = await prisma.session.create({
    data: {
      id: "70000000-0000-4000-8000-000000000001",
      user_id: helenaUser.id,
      brand_id: vertebraBrand.id,
      title: "Launch Budget vs. R&D Track",
      status: "Closed",
      friction_level: 7.8,
      calcification_delta: 4.0,
      interval_count: 6,
      glitch_count: 1,
      encauzamiento_count: 3,
      coupling_node_triggered: true,
      resolution_status: "Resolved",
      gold_extraction_status: "Pending",
      transcript_payload: sampleThread,
      glitches: [
        { id: "g1", text: "El operador racionaliza la decisión en lugar de nombrarla.", score: 6.4, ts: "2026-05-20T09:01:40Z" },
      ],
    },
  });

  const session2 = await prisma.session.create({
    data: {
      id: "70000000-0000-4000-8000-000000000002",
      user_id: marcoUser.id,
      brand_id: halconBrand.id,
      title: "Q1 Capital Reallocation",
      status: "Closed",
      friction_level: 9.1,
      calcification_delta: 7.0,
      interval_count: 9,
      glitch_count: 2,
      encauzamiento_count: 5,
      coupling_node_triggered: true,
      resolution_status: "Resolved",
      integration_signal_received_at: new Date("2026-05-04T18:00:00Z"),
      gold_extraction_status: "Extracted",
      transcript_payload: sampleThread,
      glitches: [
        { id: "g2", text: "Detección de bucle defensivo: 'el mercado lo hará por nosotros'.", score: 3.2, ts: "2026-05-03T15:40:00Z" },
        { id: "g3", text: "Reconfiguración explícita del marco de capital.", score: 7.6, ts: "2026-05-03T16:05:00Z" },
      ],
    },
  });

  const session3 = await prisma.session.create({
    data: {
      id: "70000000-0000-4000-8000-000000000003",
      user_id: anaUser.id,
      brand_id: vertebraBrand.id,
      title: "Brand Voice Audit",
      status: "Open",
      friction_level: 3.2,
      calcification_delta: 1.0,
      interval_count: 2,
      glitch_count: 0,
      encauzamiento_count: 1,
      coupling_node_triggered: false,
      resolution_status: "Unresolved",
      gold_extraction_status: "None",
      transcript_payload: sampleThread.slice(0, 2),
      glitches: [],
    },
  });

  console.log("Sessions seeded.");

  // 5. Seed Mock Knowledge Assets
  const knowledge1 = await prisma.knowledgeAsset.create({
    data: {
      id: "90000000-0000-4000-8000-000000000001",
      brand_id: vertebraBrand.id,
      title: "Vértebra · Dogma 2026",
      asset_type: "Dogma",
      status: "Active",
      source_file_url: "/mock/vertebra-dogma.pdf",
      pgvector_ref_id: "pg_vec_001",
      vectorization_status: "Embedded",
    },
  });

  const knowledge2 = await prisma.knowledgeAsset.create({
    data: {
      id: "90000000-0000-4000-8000-000000000002",
      brand_id: vertebraBrand.id,
      title: "SOP · Crisis Briefing Protocol",
      asset_type: "SOP",
      status: "Active",
      source_file_url: "/mock/sop-crisis.pdf",
      pgvector_ref_id: "pg_vec_002",
      vectorization_status: "Embedded",
    },
  });

  const knowledge3 = await prisma.knowledgeAsset.create({
    data: {
      id: "90000000-0000-4000-8000-000000000003",
      brand_id: halconBrand.id,
      title: "Halcón · Capital Allocation Doctrine",
      asset_type: "Dogma",
      status: "Active",
      source_file_url: "/mock/halcon-doctrine.pdf",
      pgvector_ref_id: null,
      vectorization_status: "Pending",
    },
  });

  const knowledge4 = await prisma.knowledgeAsset.create({
    data: {
      id: "90000000-0000-4000-8000-000000000004",
      brand_id: halconBrand.id,
      title: "Structural Gold · Halcón Q1",
      asset_type: "Gold",
      status: "Active",
      source_file_url: "/mock/halcon-gold-q1.pdf",
      pgvector_ref_id: "pg_vec_004",
      vectorization_status: "Embedded",
      source_session_id: session2.id,
    },
  });

  // Link session to its extracted asset
  await prisma.session.update({
    where: { id: session2.id },
    data: { extracted_asset_id: knowledge4.id },
  });

  console.log("Knowledge assets seeded.");
  console.log("DB seeding completed successfully.");
}

main()
  .catch((e) => {
    console.error("Error seeding DB:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
