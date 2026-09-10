import { notFound } from "next/navigation";
import { CampaignDetail } from "@/components/campaigns/campaign-detail";
import { platformOfId } from "@/lib/campaigns/campaign-id.ts";

export const metadata = { title: "Campaign" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next 16: route params are a Promise.
  const { id } = await params;
  // Either platform: an EmailBison bigint or an Instantly uuid. Anything else
  // is a 404 rather than a page that loads and then fails to find a campaign.
  if (!platformOfId(id)) notFound();

  return <CampaignDetail id={id} />;
}
