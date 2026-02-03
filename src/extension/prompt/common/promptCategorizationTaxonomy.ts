/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single source of truth for prompt categorization taxonomy.
 * Types, validation, and prompt generation all derive from this.
 */

// ============================================================================
// INTENTS - What action the user wants
// ============================================================================

export const INTENT_DEFINITIONS = {
	// Core coding tasks
	code_generation: {
		description: 'Create NEW code - typically single files, functions, or components',
		keywords: ['create', 'add', 'generate', 'write', 'make'],
		examples: ['Create a utility function', 'Generate a React component', 'Write a SQL query'],
		notes: 'NOT: Multi-file features (feature_implementation), modifying existing (code_editing)',
	},
	feature_implementation: {
		description: 'Build complete features requiring planning, multiple files, and coordinated changes',
		keywords: ['build', 'implement', 'add feature', 'create [feature name]', 'set up', 'integrate'],
		examples: ['Add user authentication', 'Build checkout flow', 'Implement search functionality'],
		notes: 'Signals: Feature names, user-facing functionality, architecture decisions, spans components',
	},
	code_editing: {
		description: 'Modify, refactor, or transform EXISTING code',
		keywords: ['refactor', 'change', 'update', 'modify', 'improve', 'simplify', 'rewrite', 'convert'],
		examples: ['Refactor this to use async/await', 'Change this to TypeScript', 'Simplify this function'],
		notes: 'Requires: Code already exists',
	},
	code_fixing: {
		description: 'Debug, fix bugs, resolve errors, or address failures',
		keywords: ['fix', 'debug', 'error', 'bug', 'broken', 'not working', 'fails', 'crash'],
		examples: ['Fix this null pointer error', 'Debug why tests are failing', 'This crashes on submit'],
		notes: 'Signals: Stack traces, error messages, test failures',
	},
	code_understanding: {
		description: 'Explain, understand, or learn about existing code',
		keywords: ['explain', 'what does', 'how does', 'why', 'understand', 'show me', 'walk through'],
		examples: ['Explain this algorithm', 'What does this regex do?', 'How does authentication work?'],
		notes: 'NOT: Asking to change code',
	},
	code_review: {
		description: 'Review, assess, or provide feedback on code quality',
		keywords: ['review', 'check', 'look at', 'feedback', 'suggestions', 'any issues', 'best practices'],
		examples: ['Review my changes', 'Any issues with this code?', 'Check for security problems'],
	},
	code_search: {
		description: 'Find, locate, or search for code, files, or patterns',
		keywords: ['find', 'where', 'search', 'locate', 'show all', 'which files'],
		examples: ['Where is the User model?', 'Find all API calls', 'Which files import this?'],
	},
	code_documentation: {
		description: 'Write or update documentation, comments, or docstrings',
		keywords: ['document', 'comment', 'docstring', 'README', 'add comments'],
		examples: ['Add docstrings to this module', 'Write a README', 'Document this API'],
	},
	code_testing: {
		description: 'Create tests, run tests, or fix test failures',
		keywords: ['test', 'unit test', 'integration test', 'coverage', 'run tests'],
		examples: ['Write unit tests for this', 'Add test coverage', 'Run the test suite'],
	},
	code_performance: {
		description: 'Optimize speed, memory, or efficiency',
		keywords: ['optimize', 'faster', 'performance', 'slow', 'memory', 'efficient', 'bottleneck'],
		examples: ['Make this faster', 'Optimize memory usage', 'This is too slow'],
		notes: 'Must: Explicitly mention performance concern',
	},
	code_refactoring: {
		description: 'Restructure code without changing behavior',
		keywords: ['refactor', 'restructure', 'reorganize', 'clean up', 'extract', 'split', 'rename'],
		examples: ['Refactor into smaller functions', 'Extract this into a module', 'Split this component'],
		notes: 'Requires: Explicit focus on structure, not behavior change',
	},
	debugging: {
		description: 'Interactive debugging session, investigating issues step by step',
		keywords: ['debug', 'step through', 'breakpoint', 'trace', 'investigate', 'why is this happening'],
		examples: ['Help me debug this', 'Step through this code', 'Why is this value wrong?'],
		notes: 'Distinct from code_fixing (applying a fix, not investigating)',
	},

	// Architecture & design
	architecture_design: {
		description: 'Architectural decisions, design patterns, or structural advice',
		keywords: ['architecture', 'design', 'structure', 'pattern', 'approach', 'should I', 'how to organize'],
		examples: ['How should I structure this?', 'What pattern should I use?', 'Should I use microservices?'],
	},
	api_design: {
		description: 'Design REST/GraphQL/gRPC APIs, endpoints, contracts',
		keywords: ['API', 'endpoint', 'REST', 'GraphQL', 'contract', 'interface design'],
		examples: ['Design an API for user management', 'What should this endpoint return?', 'Create OpenAPI spec'],
	},
	schema_design: {
		description: 'Database schema design, data modeling, entity relationships',
		keywords: ['schema', 'data model', 'entity', 'relationship', 'table design', 'ERD'],
		examples: ['Design database schema for orders', 'Model user-post relationship', 'Create migration'],
	},

	// Project & environment
	project_setup: {
		description: 'Initialize, configure, or set up projects or environments',
		keywords: ['setup', 'initialize', 'configure', 'install', 'create project', 'scaffold'],
		examples: ['Set up a React project', 'Initialize git repo', 'Configure ESLint'],
	},
	terminal_command: {
		description: 'Execute shell commands, scripts, or CLI operations',
		keywords: ['run', 'execute', 'install', 'deploy', 'commit', 'push', 'npm', 'pip', 'docker'],
		examples: ['Run the tests', 'Install dependencies', 'Deploy to production'],
	},
	dependency_management: {
		description: 'Manage packages, dependencies, version updates',
		keywords: ['package', 'dependency', 'upgrade', 'version', 'npm', 'pip', 'cargo', 'vulnerability'],
		examples: ['Update all dependencies', 'Fix security vulnerabilities', 'Add lodash package'],
	},
	migration: {
		description: 'Migrate code, data, or systems between versions/platforms',
		keywords: ['migrate', 'upgrade', 'port', 'convert', 'transition'],
		examples: ['Migrate from React 17 to 18', 'Port Python 2 to 3', 'Convert to TypeScript'],
	},

	// SCM & collaboration
	pr_management: {
		description: 'Create, review, or manage pull requests',
		keywords: ['PR', 'pull request', 'merge', 'branch', 'diff', 'changelog'],
		examples: ['Create a PR for this change', 'Write PR description', 'Generate changelog'],
	},
	issue_triage: {
		description: 'Create, analyze, or prioritize issues and bugs',
		keywords: ['issue', 'bug report', 'ticket', 'triage', 'prioritize', 'reproduce'],
		examples: ['Create an issue for this bug', 'Write reproduction steps', 'Triage these issues'],
	},
	commit_authoring: {
		description: 'Write commit messages, squash commits, manage git history',
		keywords: ['commit message', 'squash', 'rebase', 'git history', 'conventional commit'],
		examples: ['Write a commit message for this', 'Squash these commits', 'Rebase onto main'],
	},

	// DevOps
	ci_cd_config: {
		description: 'Configure CI/CD pipelines, workflows, automation',
		keywords: ['CI', 'CD', 'pipeline', 'GitHub Actions', 'Azure DevOps', 'workflow', 'automation'],
		examples: ['Set up GitHub Actions', 'Add deployment pipeline', 'Configure build workflow'],
	},
	deployment: {
		description: 'Deploy applications, manage releases, rollbacks',
		keywords: ['deploy', 'release', 'rollback', 'staging', 'production', 'blue-green'],
		examples: ['Deploy to production', 'Rollback last release', 'Set up staging environment'],
	},
	monitoring_observability: {
		description: 'Set up logging, monitoring, alerting, tracing',
		keywords: ['logging', 'monitoring', 'metrics', 'alerting', 'APM', 'tracing', 'observability'],
		examples: ['Add logging to this service', 'Set up error alerting', 'Configure APM'],
	},

	// Quality & security
	security_audit: {
		description: 'Security review, vulnerability analysis, threat modeling',
		keywords: ['security', 'vulnerability', 'audit', 'threat model', 'penetration', 'OWASP'],
		examples: ['Review for security issues', 'Find vulnerabilities', 'Check for XSS'],
	},
	accessibility_review: {
		description: 'Accessibility audit, a11y improvements, WCAG compliance',
		keywords: ['accessibility', 'a11y', 'WCAG', 'screen reader', 'ARIA', 'keyboard navigation'],
		examples: ['Check for accessibility issues', 'Add ARIA labels', 'Make keyboard navigable'],
	},

	// Data & analytics
	data_analysis: {
		description: 'Analyze, process, or transform data (not visualize)',
		keywords: ['analyze', 'process', 'parse', 'calculate', 'aggregate'],
		examples: ['Analyze this CSV', 'Parse this JSON', 'Calculate statistics'],
	},
	data_visualization: {
		description: 'Create charts, graphs, or visual representations',
		keywords: ['chart', 'graph', 'plot', 'visualize', 'dashboard'],
		examples: ['Create a bar chart', 'Plot this data', 'Make a dashboard'],
	},
	document_processing: {
		description: 'Extract, transform, or generate documents (PDFs, spreadsheets, reports)',
		keywords: ['extract', 'PDF', 'invoice', 'spreadsheet', 'report', 'convert', 'parse document'],
		examples: ['Extract data from invoices', 'Convert PDF to CSV', 'Generate weekly report'],
	},
	workflow_automation: {
		description: 'Automate tasks across apps, create integrations, set up triggers',
		keywords: ['automate', 'integrate', 'sync', 'trigger', 'when X happens', 'connect', 'bulk'],
		examples: ['Sync Slack with Salesforce', 'Auto-notify on updates', 'Bulk update records'],
	},

	// Learning & planning
	learning_tutorial: {
		description: 'Learn concepts, frameworks, or general programming knowledge',
		keywords: ['how to', 'learn', 'teach me', 'tutorial', 'what is'],
		examples: ['How do React hooks work?', 'Teach me about promises', 'What is the difference between let and const?'],
	},
	requirements_analysis: {
		description: 'Analyze, clarify, or document requirements',
		keywords: ['requirements', 'spec', 'user story', 'acceptance criteria', 'scope'],
		examples: ['Write user stories for this feature', 'Define acceptance criteria', 'Clarify requirements'],
	},
	estimation: {
		description: 'Effort estimation, planning, sizing work',
		keywords: ['estimate', 'how long', 'story points', 'effort', 'complexity', 'timeline'],
		examples: ['How long will this take?', 'Estimate story points', 'Break down this epic'],
	},
	general_question: {
		description: 'General questions, chitchat, or unclear requests',
		keywords: [],
		examples: ['Hello', 'What can you do?', 'Help'],
		notes: 'Use when message does not clearly fit other categories',
	},
} as const satisfies Record<string, CategoryDefinition>;

// ============================================================================
// DOMAINS - What area of code/system (orthogonal to intents)
// ============================================================================

export const DOMAIN_DEFINITIONS = {
	// Engineering domains
	frontend: {
		description: 'UI, client-side code, user interface',
		signals: ['HTML', 'CSS', 'JavaScript', 'React', 'Vue', 'Angular', 'Svelte', 'DOM', 'styling', 'components'],
	},
	backend: {
		description: 'Server-side code, APIs, business logic',
		signals: ['API', 'server', 'endpoint', 'route', 'controller', 'service', 'database queries', 'authentication'],
	},
	full_stack: {
		description: 'Crosses multiple domains (frontend + backend + database)',
		signals: ['mentions multiple domains', 'full application'],
	},
	mobile: {
		description: 'Mobile application development (iOS, Android, cross-platform)',
		signals: ['iOS', 'Android', 'React Native', 'Flutter', 'Swift', 'Kotlin', 'mobile app'],
	},
	database: {
		description: 'Database schema, queries, migrations, data modeling',
		signals: ['SQL', 'database', 'table', 'schema', 'migration', 'query', 'ORM', 'Postgres', 'MySQL', 'MongoDB'],
	},
	infrastructure: {
		description: 'Cloud infrastructure, DevOps, CI/CD, containers, orchestration',
		signals: ['Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'Terraform', 'GitHub Actions', 'pipeline', 'SRE'],
	},

	// Quality & process
	testing: {
		description: 'Test code, test frameworks, test infrastructure',
		signals: ['test files', 'Jest', 'pytest', 'Mocha', 'unit test', 'integration test', 'E2E'],
	},
	quality_assurance: {
		description: 'QA processes, manual testing, test planning, bug tracking',
		signals: ['test plan', 'test case', 'QA', 'regression', 'smoke test', 'UAT'],
	},
	security: {
		description: 'Security, authentication, authorization, vulnerabilities',
		signals: ['auth', 'security', 'vulnerability', 'encryption', 'permissions', 'CORS', 'XSS'],
	},
	accessibility: {
		description: 'Accessibility (a11y), inclusive design, assistive technology support',
		signals: ['WCAG', 'ARIA', 'screen reader', 'keyboard navigation', 'a11y'],
	},

	// Design & UX
	design_systems: {
		description: 'Component libraries, design tokens, UI patterns',
		signals: ['design system', 'component library', 'tokens', 'Storybook', 'UI kit'],
	},
	ux_design: {
		description: 'User experience design, user flows, interaction patterns',
		signals: ['UX', 'user flow', 'wireframe', 'prototype', 'interaction', 'Figma'],
	},

	// Data & ML
	data_science: {
		description: 'Data work: analysis, visualization, scientific computing, statistics, dashboards',
		signals: ['pandas', 'numpy', 'matplotlib', 'Jupyter', 'statistics', 'metrics', 'KPI', 'dashboard'],
	},
	machine_learning: {
		description: 'ML models, training, inference, MLOps',
		signals: ['TensorFlow', 'PyTorch', 'scikit-learn', 'model training', 'LLM', 'neural network'],
	},

	// Tooling & docs
	tooling_config: {
		description: 'Build tools, linters, formatters, development environment',
		signals: ['Webpack', 'Babel', 'ESLint', 'Prettier', 'tsconfig', 'package.json', 'build config'],
	},
	documentation: {
		description: 'Docs, comments, README files, API documentation',
		signals: ['README', 'documentation', 'comments', 'docstrings', 'API docs'],
	},

	// General
	algorithms: {
		description: 'Algorithms, data structures, computational problems',
		signals: ['algorithm names', 'data structures', 'sorting', 'searching', 'complexity', 'Big O'],
	},
	general_programming: {
		description: 'General programming concepts, language features, patterns',
		signals: ['language features', 'programming concepts', 'general advice'],
	},
	project_management: {
		description: 'Project planning, coordination, process improvement',
		signals: ['sprint', 'roadmap', 'milestone', 'Agile', 'Scrum', 'Kanban', 'JIRA'],
	},
	unknown_domain: {
		description: 'Domain cannot be determined from message',
		signals: [],
	},
} as const satisfies Record<string, CategoryDefinition>;

// ============================================================================
// SCOPES - What code context is needed
// ============================================================================

export const SCOPE_DEFINITIONS = {
	// File-level scopes
	selection: {
		description: 'Operates on user\'s currently selected/highlighted code',
		signals: ['user has active selection', 'uses "this"'],
	},
	current_file: {
		description: 'Entire file user is currently viewing/editing',
		signals: ['"this file"', 'mentions filename', 'file-level operation'],
	},
	few_files: {
		description: 'Small set of related files (2-5 files)',
		signals: ['"this component and its tests"', 'specific file mentions'],
	},
	many_files: {
		description: 'Large set of files or entire module/package',
		signals: ['"all components"', '"entire module"', '"across files"'],
	},

	// Repository scopes
	codebase: {
		description: 'Entire project/codebase understanding required',
		signals: ['"project"', '"codebase"', '"application"', '"system"', 'architecture-level'],
	},
	multi_repository: {
		description: 'Operates across multiple repositories (microservices, monorepo packages)',
		signals: ['"other repo"', '"microservice"', '"shared library"', 'cross-repo dependency', 'multi-package'],
	},

	// External scopes
	scm_operations: {
		description: 'Git operations, branch management, PR creation',
		signals: ['git commands', 'branch', 'PR', 'merge', 'rebase', 'git history'],
	},
	issue_tracker: {
		description: 'Operates on issue tracking systems (GitHub Issues, JIRA, Linear)',
		signals: ['issue', 'bug', 'ticket', 'backlog', 'sprint', 'tracking system'],
	},
	remote_service: {
		description: 'Interacts with external services, APIs, or cloud resources',
		signals: ['external API', 'cloud service', 'SaaS', 'third-party', 'webhook'],
	},
	external: {
		description: 'Requires knowledge outside the codebase (docs, web, general knowledge)',
		signals: ['questions about languages', 'frameworks', 'best practices', '"how to" (general)'],
	},

	// Transient
	ephemeral: {
		description: 'One-off task, doesn\'t directly modify main codebase',
		signals: ['"write a script to"', '"analyze this data"', 'temporary/throwaway work'],
	},
} as const satisfies Record<string, CategoryDefinition>;

// ============================================================================
// Shared types and utilities
// ============================================================================

interface CategoryDefinition {
	description: string;
	keywords?: readonly string[];
	examples?: readonly string[];
	signals?: readonly string[];
	notes?: string;
}

/** Extract keys as union type */
export type PromptIntent = keyof typeof INTENT_DEFINITIONS;
export type PromptDomain = keyof typeof DOMAIN_DEFINITIONS;
export type PromptScope = keyof typeof SCOPE_DEFINITIONS;

/** Validation sets - derived from definitions */
export const VALID_INTENTS = new Set(Object.keys(INTENT_DEFINITIONS)) as ReadonlySet<PromptIntent>;
export const VALID_DOMAINS = new Set(Object.keys(DOMAIN_DEFINITIONS)) as ReadonlySet<PromptDomain>;
export const VALID_SCOPES = new Set(Object.keys(SCOPE_DEFINITIONS)) as ReadonlySet<PromptScope>;

/** Type guards */
export function isValidIntent(value: string): value is PromptIntent {
	return VALID_INTENTS.has(value as PromptIntent);
}
export function isValidDomain(value: string): value is PromptDomain {
	return VALID_DOMAINS.has(value as PromptDomain);
}
export function isValidScope(value: string): value is PromptScope {
	return VALID_SCOPES.has(value as PromptScope);
}

/**
 * The classification result structure
 */
export interface PromptClassification {
	intent: PromptIntent;
	domain: PromptDomain;
	timeEstimate: {
		/** ISO 8601 duration for best case scenario, e.g., "PT5M" for 5 minutes */
		bestCase: string;
		/** ISO 8601 duration for realistic scenario, e.g., "PT15M" for 15 minutes */
		realistic: string;
	};
	scope: PromptScope;
	/** Confidence score between 0.0 and 1.0 */
	confidence: number;
	/** Brief reasoning for the classification */
	reasoning: string;
}

// ============================================================================
// Prompt generation helpers
// ============================================================================

function formatCategoryForPrompt(key: string, def: CategoryDefinition): string {
	const parts = [`## ${key}`, def.description];

	if (def.keywords?.length) {
		parts.push(`Keywords: ${def.keywords.map(k => `"${k}"`).join(', ')}`);
	}
	if (def.signals?.length) {
		parts.push(`Signals: ${def.signals.join(', ')}`);
	}
	if (def.examples?.length) {
		parts.push(`Examples: ${def.examples.map(e => `"${e}"`).join(', ')}`);
	}
	if (def.notes) {
		parts.push(def.notes);
	}

	return parts.join('\n');
}

/** Generate prompt section for intents */
export function generateIntentPromptSection(): string {
	const header = '# INTENT - What action the user wants (choose ONE)\n';
	const categories = Object.entries(INTENT_DEFINITIONS)
		.map(([key, def]) => formatCategoryForPrompt(key, def))
		.join('\n\n');
	return header + categories;
}

/** Generate prompt section for domains */
export function generateDomainPromptSection(): string {
	const header = '# DOMAIN - What area of code/system (choose ONE)\nNote: Domains are orthogonal to intents - e.g., security_audit (intent) on frontend (domain)\n';
	const categories = Object.entries(DOMAIN_DEFINITIONS)
		.map(([key, def]) => formatCategoryForPrompt(key, def))
		.join('\n\n');
	return header + categories;
}

/** Generate prompt section for scopes */
export function generateScopePromptSection(): string {
	const header = '# SCOPE - What code context is needed (choose ONE)\n';
	const categories = Object.entries(SCOPE_DEFINITIONS)
		.map(([key, def]) => formatCategoryForPrompt(key, def))
		.join('\n\n');
	return header + categories;
}

/** Generate full taxonomy prompt */
export function generateTaxonomyPrompt(): string {
	return [
		generateIntentPromptSection(),
		generateDomainPromptSection(),
		'# TIME ESTIMATE',
		'Estimate how long an **experienced developer familiar with the codebase** would take:',
		'- Consider: understanding requirements, writing code, testing, debugging, code review',
		'- Format: ISO 8601 duration (e.g., "PT5M" for 5 minutes, "PT1H30M" for 1.5 hours)',
		'- Provide both "bestCase" (everything goes smoothly) and "realistic" (typical complications)',
		'',
		generateScopePromptSection(),
	].join('\n\n');
}
