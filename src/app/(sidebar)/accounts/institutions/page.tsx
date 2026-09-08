import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function InstitutionsPage() {
  redirect("/settings/institutions");
}
