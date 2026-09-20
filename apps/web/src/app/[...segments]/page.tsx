import { findWorkspaceRoute, workspaceRoutes } from "@abos/contracts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ModuleFoundation } from "@/components/ModuleFoundation";
import { ProjectsWorkspace } from "@/components/ProjectsWorkspace";
import { SalesCrmWorkspace } from "@/components/SalesCrmWorkspace";

interface ModulePageProps {
  readonly params: Promise<{ segments: string[] }>;
}

function pathFromSegments(segments: readonly string[]): string {
  return `/${segments.join("/")}`;
}

export function generateStaticParams() {
  return workspaceRoutes
    .filter((route) => route.path !== "/")
    .map((route) => ({ segments: route.path.slice(1).split("/") }));
}

export async function generateMetadata({ params }: ModulePageProps): Promise<Metadata> {
  const { segments } = await params;
  const route = findWorkspaceRoute(pathFromSegments(segments));
  return route ? { title: route.label, description: route.description } : {};
}

export default async function ModulePage({ params }: ModulePageProps) {
  const { segments } = await params;
  const route = findWorkspaceRoute(pathFromSegments(segments));

  if (!route || route.path === "/") {
    notFound();
  }

  if (route.id === "projects") {
    return <ProjectsWorkspace />;
  }

  if (route.id === "sales-crm") {
    return <SalesCrmWorkspace />;
  }

  return <ModuleFoundation route={route} />;
}
