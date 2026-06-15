import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Creating test admin user...");

  const passwordHash = bcrypt.hashSync("admin123", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@pkgd.os" },
    update: {
      full_name: "Admin Dev",
      password_hash: passwordHash,
      global_role: "admin",
    },
    create: {
      id: "a0000000-0000-4000-8000-000000000001",
      full_name: "Admin Dev",
      email: "admin@pkgd.os",
      password_hash: passwordHash,
      global_role: "admin",
      friction_level: 0.0,
      calcification_level: 0.0,
    },
  });

  console.log("✅ Admin user ready:");
  console.log(`   Email:    ${admin.email}`);
  console.log(`   Password: admin123`);
  console.log(`   Role:     ${admin.global_role}`);
  console.log(`   ID:       ${admin.id}`);
}

main()
  .catch((e) => {
    console.error("❌ Error creating admin:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
