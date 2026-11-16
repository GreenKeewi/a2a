import { WorkspaceDashboard } from "@/components/workspace-dashboard";

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) { return <WorkspaceDashboard slug={(await params).slug} section="settings" />; }
