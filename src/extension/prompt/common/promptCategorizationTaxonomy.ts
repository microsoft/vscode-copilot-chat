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
		notes: 'NOT: Multi-file features (new_feature), modifying existing (code_editing), creating tests (code_testing), creating docs/README/markdown (code_documentation)',
	},
	new_feature: {
		description: 'Build a new user-facing feature requiring coordinated code changes across multiple files',
		keywords: ['build', 'implement', 'add feature', 'create [feature name]', 'set up', 'integrate'],
		examples: ['Add user authentication', 'Build checkout flow', 'Implement search functionality', 'Add a flight tracker page'],
		notes: 'Requires: explicit request to WRITE CODE that spans multiple files. NOT: researching/investigating (research_investigation), planning/architecture advice (architecture_design), asking questions about features (code_understanding), running builds (terminal_command), creating non-code content like videos or articles (content_creation), or DESCRIBING PROBLEMS with existing UI/features (code_fixing). "Research implementation" or "come up with a plan" are NOT this intent. Words like "new" or "create" appearing as part of a feature name or context (e.g. "the input for creating new X is too small") do NOT make it new_feature — check the user\'s GOAL.',
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
		description: 'Explain, understand, or learn about existing code in the workspace',
		keywords: ['explain', 'what does', 'how does', 'why', 'understand', 'show me', 'walk through'],
		examples: ['Explain this algorithm', 'What does this regex do?', 'How does authentication work in this project?'],
		notes: 'Only for understanding existing code. NOT: investigating failures/errors (debugging), finding/locating code (code_search), applying fixes (code_fixing), researching external libraries or repos (research_investigation). Focus on the user\'s GOAL — if they say "understand why X fails", the goal is debugging, not understanding.',
	},
	code_review: {
		description: 'Review, assess, or provide feedback on code quality',
		keywords: ['review', 'check', 'look at', 'feedback', 'suggestions', 'any issues', 'best practices'],
		examples: ['Review my changes', 'Any issues with this code?', 'Check for security problems'],
	},
	code_search: {
		description: 'Find, locate, or search for specific code, files, or patterns by name or reference',
		keywords: ['find', 'where', 'search', 'locate', 'show all', 'which files'],
		examples: ['Where is the User model?', 'Find all API calls', 'Which files import this?', 'Search for all usages of handleClick'],
		notes: 'Only for LOCATING specific code or files. NOT: understanding how something works (code_understanding), broad exploration of how a system is built (research_investigation), or investigating failures (debugging). "Find where X is defined" = code_search. "Research how X handles auth" = research_investigation.',
	},
	code_documentation: {
		description: 'Write or update documentation, comments, docstrings, technical markdown documents, or technical diagrams (UML, sequence, architecture)',
		keywords: ['document', 'comment', 'docstring', 'README', 'add comments', 'write documentation', 'markdown', 'sequence diagram', 'UML'],
		examples: ['Add docstrings to this module', 'Write a README', 'Document this API', 'Produce a deep-dive markdown on this topic', 'Create a sequence diagram for the login flow'],
		notes: 'Preferred over code_generation when the output is documentation/markdown/README. Preferred over data_visualization when the output is a technical diagram (UML, sequence, architecture). "Write a README" or "produce a markdown document" = code_documentation.',
	},
	code_testing: {
		description: 'Create tests, run tests, or fix test failures',
		keywords: ['test', 'unit test', 'integration test', 'coverage', 'run tests', 'add tests', 'write tests', 'spec'],
		examples: ['Write unit tests for this', 'Add test coverage', 'Run the test suite', 'Add tests for this function'],
		notes: 'Preferred over code_generation when the output is specifically tests. "Add tests for X" = code_testing, not code_generation.',
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
		description: 'Investigating issues, failures, or unexpected behavior step by step',
		keywords: ['debug', 'step through', 'breakpoint', 'trace', 'investigate', 'why is this happening', 'figure out why', 'what went wrong'],
		examples: ['Help me debug this', 'Step through this code', 'Why is this value wrong?', 'Investigate why this fails', 'Analyze what went wrong in this CI run', 'Figure out why X is not working'],
		notes: 'Distinct from code_fixing (applying a fix, not investigating). Use debugging when the user is INVESTIGATING a problem. "Investigate why X fails" or "analyze this error" = debugging. "Analyze this CI run failure" = debugging, NOT data_analysis.',
	},

	// Delegation & slash commands
	slash_command: {
		description: 'User delegates to an instruction file, prompt file, skill file, or slash command whose content determines the real intent',
		keywords: ['follow instructions in', 'execute this plan', 'use prompt', 'run skill', '/'],
		examples: ['Follow instructions in SKILL.md', 'Follow instructions in spellcheck.prompt.md', 'Execute this plan', '/outline', '/fix'],
		notes: 'Use when the prompt ITSELF does not contain enough information to determine intent — instead it delegates to a referenced file or slash command. The actual intent depends on the referenced content, which is not visible. Confidence MUST be low (0.3-0.5) because the classification is inherently uncertain. Do NOT guess a specific coding intent when the prompt is pure delegation.',
	},

	// Research & investigation
	research_investigation: {
		description: 'Research, investigate, or explore codebases, libraries, APIs, or technical topics in depth',
		keywords: ['research', 'investigate', 'explore', 'survey', 'assess', 'compare', 'evaluate', 'discovery'],
		examples: ['Research how this library handles auth', 'Investigate the implementation of X in this repo', 'Explore what options exist for WASM embedding', 'Research implementation requirements for this system'],
		notes: 'For exploratory tasks where the goal is GATHERING INFORMATION, not taking action. "Research implementation of X" = research_investigation (researching), NOT new_feature (implementing). "Investigate why X fails" with a clear error = debugging instead.',
	},

	// Architecture & design
	architecture_design: {
		description: 'Architectural decisions, design patterns, structural advice, or creating plans for code changes',
		keywords: ['architecture', 'design', 'structure', 'pattern', 'approach', 'should I', 'how to organize', 'come up with a plan', 'plan to restructure'],
		examples: ['How should I structure this?', 'What pattern should I use?', 'Should I use microservices?', 'Come up with a plan to split the monolith', 'Make a plan to improve this controller'],
		notes: 'Use when the user asks for a PLAN or structural advice, even if the eventual outcome would be code changes. "Come up with a plan to..." = architecture_design, not new_feature.',
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
		description: 'Deploy applications to remote environments, manage releases, rollbacks',
		keywords: ['deploy', 'release', 'rollback', 'staging', 'production', 'blue-green'],
		examples: ['Deploy to production', 'Rollback last release', 'Set up staging environment'],
		notes: 'For pushing code to remote environments (staging, production). NOT: building/running locally (terminal_command). "Build and run in debug mode" = terminal_command. "Deploy to production" = deployment.',
	},
	monitoring_observability: {
		description: 'Set up logging, monitoring, alerting, tracing',
		keywords: ['logging', 'monitoring', 'metrics', 'alerting', 'APM', 'tracing', 'observability'],
		examples: ['Add logging to this service', 'Set up error alerting', 'Configure APM'],
		notes: 'For SETTING UP or CONFIGURING monitoring/logging infrastructure. NOT: checking CI error logs or diagnosing failures (debugging). "Check latest GH Action error logs" = debugging. "Set up Datadog alerting" = monitoring_observability.',
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
		description: 'Process, transform, or compute statistics over structured/tabular data',
		keywords: ['process', 'parse', 'calculate', 'aggregate', 'extract data', 'transform data', 'statistics'],
		examples: ['Analyze this CSV', 'Parse this JSON', 'Calculate statistics', 'Extract data from these PR records'],
		notes: 'Only for processing structured DATA — not for investigating failures (debugging), reviewing code quality (code_review), learning about libraries (learning_tutorial), or triaging issues (issue_triage). The word "analyze" alone does NOT make something data_analysis — check WHAT is being analyzed.',
	},
	data_visualization: {
		description: 'Create charts, graphs, or visual data representations from structured data',
		keywords: ['chart', 'graph', 'plot', 'visualize', 'dashboard'],
		examples: ['Create a bar chart', 'Plot this data', 'Make a dashboard'],
		notes: 'For rendering DATA as visual charts/plots. NOT: UML diagrams, sequence diagrams, or architecture diagrams (code_documentation). "Plot this CSV" = data_visualization. "Create a sequence diagram for the login flow" = code_documentation.',
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
	content_creation: {
		description: 'Create non-code content such as videos, articles, presentations, or creative assets',
		keywords: ['video', 'article', 'presentation', 'slides', 'course', 'tutorial content', 'blog post'],
		examples: ['Create a video course module', 'Write a blog post about X', 'Build a presentation on Y'],
		notes: 'For creative/content OUTPUT that is not code or documentation. Video courses, articles, training materials. NOT: technical documentation (code_documentation), code features (new_feature).',
	},

	// Learning & planning
	learning_tutorial: {
		description: 'Learn concepts, frameworks, or general programming knowledge',
		keywords: ['how to', 'learn', 'teach me', 'tutorial', 'what is'],
		examples: ['How do React hooks work?', 'Teach me about promises', 'What is the difference between let and const?'],
		notes: '"Learn" must be the GOAL, not a means. "Learn from this commit and find similar issues" = code_search (the goal is finding), not learning_tutorial. "Research library capabilities" = research_investigation.',
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
		description: 'General questions, non-software requests, chitchat, or unclear requests',
		keywords: [],
		examples: ['Hello', 'What can you do?', 'Help', 'Find bike rental shops in Cape Town', 'Make me a business plan for socks'],
		notes: 'Use for ANY prompt that is NOT about software development, coding, or technical work. Non-coding requests (shopping, business plans, recipes, career advice, creative writing) MUST use this intent. Also use for meta-questions about the AI tool itself ("list your skills", "what can you do?").',
	},
	unknown_intent: {
		description: 'Intent cannot be determined from message',
		keywords: [],
		examples: [],
		notes: 'Use when the request is too ambiguous to classify. Confidence MUST be low (0.3-0.5) when using this intent.',
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
		description: 'Build tools, linters, formatters, development environment, editor extensions, MCP servers',
		signals: ['Webpack', 'Babel', 'ESLint', 'Prettier', 'tsconfig', 'package.json', 'build config', 'VS Code extension', 'MCP server', 'editor config', 'rspack', 'vite config', 'xcodebuild'],
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
		signals: ['git commands', 'branch', 'PR', 'merge', 'rebase', 'git history', 'cherry-pick', 'git push', 'git pull', 'git fetch', 'git commit', 'git diff', 'git stash'],
	},
	issue_tracker: {
		description: 'Operates on issue tracking systems (GitHub Issues, JIRA, Linear)',
		signals: ['issue', 'bug', 'ticket', 'backlog', 'sprint', 'tracking system'],
	},
	remote_service: {
		description: 'Interacts with external services, APIs, cloud resources, or remote databases',
		signals: ['external API', 'cloud service', 'SaaS', 'third-party', 'webhook', 'staging database', 'production database', 'remote connection', 'SSH'],
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
	unknown_scope: {
		description: 'Scope cannot be determined from message',
		signals: [],
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

/** Classification guidance for the LLM */
const CLASSIFICATION_GUIDANCE = `# CLASSIFICATION GUIDANCE

Keywords, signals, and examples are **illustrative, not exhaustive**. Focus on semantic intent, not keyword matching.

## Pre-classification check
1. **Is this about software/coding/technical work?** If NO → general_question. Non-coding prompts (shopping, business plans, recipes, career advice) MUST NOT receive coding intents.
2. **Is the user asking to DO something or LEARN/RESEARCH something?** "Research X" or "investigate X" = research_investigation or debugging, NOT the action intent. "Come up with a plan" = architecture_design, NOT new_feature.
3. **Is the output tests or documentation?** "Add tests" = code_testing. "Write README" = code_documentation. NOT code_generation.

## Disambiguation rules (check the OBJECT or GOAL, not the verb)
- "Analyze" / "Check logs" → data/CSV/JSON = data_analysis; failures/errors/logs = debugging; code quality = code_review; libraries/work items = research_investigation
- "Research" / "Investigate" → gathering info = research_investigation; diagnosing a failure = debugging; locating a file = code_search
- "Build" / "Run" → the project locally = terminal_command; a feature = new_feature; a video/article = content_creation. Local execution ≠ deployment
- "Implement" → "research implementation" = research_investigation; "implement this feature" = new_feature
- "Learn from X and do Y" → intent is Y (the goal), not learning_tutorial
- UML / sequence diagrams → code_documentation, NOT data_visualization
- Delegation ("Follow instructions in X.md", "Execute this plan") → slash_command, confidence 0.3-0.5

## Multi-intent prompts
When a prompt contains multiple intents (e.g., "Research X and then migrate Y"), classify by the PRIMARY GOAL — the end outcome the user wants. Intermediate steps are means, not the intent. Example: "Connect to staging DB to learn schemas, then migrate data to prod" → migration (the goal), not research_investigation (the means).

## Confidence calibration
- **0.85-1.0**: Unambiguous prompt, clear single intent. Example: "Fix this null pointer error" = code_fixing/0.95
- **0.7-0.85**: Clear intent but some field ambiguity. Example: "How should I handle auth?" (learning vs architecture)
- **0.5-0.7**: Genuinely ambiguous, multiple intents plausible. Example: "Look at this code" (review vs understanding)
- **0.3-0.5**: Very ambiguous or insufficient context. Example: "execute phase 5", delegation prompts
- **< 0.3**: Should almost never be used. If you cannot classify at all, use unknown_intent with 0.3-0.4
- **Avoid** defaulting to 0.9 for every prompt. Confidence MUST vary based on actual classification difficulty.
- When domain or scope is unknown, cap confidence at 0.7 maximum.`;

/** Generate full taxonomy prompt */
export function generateTaxonomyPrompt(): string {
	return [
		CLASSIFICATION_GUIDANCE,
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

// ============================================================================
// Tool calling schema for structured output
// ============================================================================

/** Tool name for prompt categorization */
export const CATEGORIZE_PROMPT_TOOL_NAME = 'categorize_prompt';

/** JSON Schema for the categorize_prompt tool parameters */
export const CATEGORIZE_PROMPT_TOOL_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		intent: {
			type: 'string',
			enum: Object.keys(INTENT_DEFINITIONS),
			description: 'The primary action the user wants to perform'
		},
		domain: {
			type: 'string',
			enum: Object.keys(DOMAIN_DEFINITIONS),
			description: 'The area of code or system the request relates to'
		},
		scope: {
			type: 'string',
			enum: Object.keys(SCOPE_DEFINITIONS),
			description: 'The code context required to fulfill the request'
		},
		timeEstimate: {
			type: 'object',
			additionalProperties: false,
			properties: {
				bestCase: {
					type: 'string',
					description: 'ISO 8601 duration for best case scenario (e.g., "PT5M" for 5 minutes)'
				},
				realistic: {
					type: 'string',
					description: 'ISO 8601 duration for realistic scenario (e.g., "PT15M" for 15 minutes)'
				}
			},
			required: ['bestCase', 'realistic']
		},
		confidence: {
			type: 'number',
			minimum: 0,
			maximum: 1,
			description: 'Confidence score between 0.0 and 1.0'
		},
		reasoning: {
			type: 'string',
			description: 'Brief 1-2 sentence explanation for the classification'
		}
	},
	required: ['intent', 'domain', 'scope', 'timeEstimate', 'confidence', 'reasoning']
} as const;
