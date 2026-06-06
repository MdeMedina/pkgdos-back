import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== PKGD OS: Starting Session Token Backfill ===");
  
  // Find all users where session_token_n8n is null
  const users = await prisma.user.findMany({
    where: {
      session_token_n8n: null,
    },
  });

  console.log(`Found ${users.length} users with null session_token_n8n.`);

  let updatedCount = 0;
  for (const user of users) {
    const sessionTokenN8n = `n8n.token.${Math.random().toString(36).substring(2, 10)}`;
    await prisma.user.update({
      where: { id: user.id },
      data: { session_token_n8n: sessionTokenN8n },
    });
    console.log(`Updated user ${user.email} (ID: ${user.id}) -> token: ${sessionTokenN8n}`);
    updatedCount++;
  }

  console.log(`Successfully backfilled ${updatedCount} users.`);
  console.log("==================================================");
}

main()
  .catch((e) => {
    console.error("Backfill failed with error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
