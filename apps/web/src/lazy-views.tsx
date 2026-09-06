import { lazy } from "react";

// Feature modules load on demand; importing this registry does not load every management/report dependency.
export const Articles = lazy(() => import("./components/Articles").then((module) => ({ default: module.Articles })));
export const Attribution = lazy(() =>
	import("./components/Attribution").then((module) => ({ default: module.Attribution })),
);
export const AuditLogs = lazy(() => import("./components/AuditLogs").then((module) => ({ default: module.AuditLogs })));
export const Diagnosis = lazy(() => import("./components/Diagnosis").then((module) => ({ default: module.Diagnosis })));
export const Evidence = lazy(() => import("./components/Evidence").then((module) => ({ default: module.Evidence })));
export const KnowledgeBase = lazy(() =>
	import("./components/KnowledgeBase").then((module) => ({ default: module.KnowledgeBase })),
);
export const Members = lazy(() => import("./components/Members").then((module) => ({ default: module.Members })));
export const Monitoring = lazy(() =>
	import("./components/Monitoring").then((module) => ({ default: module.Monitoring })),
);
export const Onboarding = lazy(() =>
	import("./components/Onboarding").then((module) => ({ default: module.Onboarding })),
);
export const OrganizationManagement = lazy(() =>
	import("./components/OrganizationManagement").then((module) => ({ default: module.OrganizationManagement })),
);
export const Overview = lazy(() => import("./components/Overview").then((module) => ({ default: module.Overview })));
export const RbacManagement = lazy(() =>
	import("./components/RbacManagement").then((module) => ({ default: module.RbacManagement })),
);
export const Remediation = lazy(() =>
	import("./components/Remediation").then((module) => ({ default: module.Remediation })),
);
export const Report = lazy(() => import("./components/Report").then((module) => ({ default: module.Report })));
export const ServiceLogs = lazy(() =>
	import("./components/ServiceLogs").then((module) => ({ default: module.ServiceLogs })),
);
export const Settings = lazy(() => import("./components/Settings").then((module) => ({ default: module.Settings })));
export const Workbench = lazy(() => import("./components/Workbench").then((module) => ({ default: module.Workbench })));
