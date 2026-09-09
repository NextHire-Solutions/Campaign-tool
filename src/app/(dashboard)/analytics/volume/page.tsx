import { Suspense } from "react";
import { VolumeView } from "@/components/analytics/volume-view";

export default function VolumePage() {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
      <div className="space-y-5 p-6">
        <header className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Email volume</h1>
        </header>
        <Suspense fallback={null}>
          <VolumeView />
        </Suspense>
      </div>
    </div>
  );
}
