// Rudimentary date-fns implementations
const parseISO = (dateString: string): Date => {
	return new Date(dateString);
};

const subDays = (date: Date, amount: number): Date => {
	const newDate = new Date(date);
	newDate.setDate(newDate.getDate() - amount);
	return newDate;
};

const differenceInDays = (dateLeft: Date, dateRight: Date): number => {
	const diffTime = dateLeft.getTime() - dateRight.getTime();
	return Math.round(diffTime / (1000 * 60 * 60 * 24));
};

const differenceInMinutes = (dateLeft: Date, dateRight: Date): number => {
	const diffTime = Math.abs(dateLeft.getTime() - dateRight.getTime());
	return Math.ceil(diffTime / (1000 * 60));
};

// Interfaces for DORA metrics data
interface Deployment {
	id: string;
	timestamp: string;
	environment: 'production' | 'staging';
	result: 'success' | 'failure';
	commitSha: string;
	team?: string;
}

interface Incident {
	id: string;
	startTime: string;
	endTime: string | null;
	deploymentId?: string;
}

interface PullRequest {
	id: string;
	commitSha: string;
	createdAt: string;
	mergedAt: string | null;
	baseBranch: string;
}

// --- Data Generation (for simulation purposes) ---
const generateId = () => Math.random().toString(36).substring(2, 10);

const generateDeployments = (count: number): Deployment[] => {
	const deployments: Deployment[] = [];
	let currentDate = new Date();
	for (let i = 0; i < count; i++) {
		currentDate = subDays(currentDate, Math.random() * 3);
		deployments.push({
			id: generateId(),
			timestamp: currentDate.toISOString(),
			environment: 'production',
			result: Math.random() > 0.1 ? 'success' : 'failure',
			commitSha: generateId(),
			team: Math.random() > 0.5 ? 'Team A' : 'Team B',
		});
	}
	return deployments;
};

const generateIncidents = (deployments: Deployment[]): Incident[] => {
	const incidents: Incident[] = [];
	deployments.forEach(deployment => {
		if (deployment.result === 'failure' && Math.random() > 0.5) {
			const startTime = new Date(deployment.timestamp);
			const endTime = new Date(startTime.getTime() + Math.random() * 1000 * 60 * 120); // 0-120 minutes to resolve
			incidents.push({
				id: generateId(),
				startTime: startTime.toISOString(),
				endTime: endTime.toISOString(),
				deploymentId: deployment.id,
			});
		}
	});
	// Add some random incidents not tied to deployments
	for (let i = 0; i < 5; i++) {
		const startTime = subDays(new Date(), Math.random() * 90);
		const endTime = new Date(startTime.getTime() + Math.random() * 1000 * 60 * 240);
		incidents.push({
			id: generateId(),
			startTime: startTime.toISOString(),
			endTime: endTime.toISOString(),
		});
	}
	return incidents;
};

const generatePullRequests = (deployments: Deployment[]): PullRequest[] => {
	const prs: PullRequest[] = [];
	deployments.forEach(deployment => {
		const createdAt = subDays(parseISO(deployment.timestamp), Math.random() * 10);
		prs.push({
			id: generateId(),
			commitSha: deployment.commitSha,
			createdAt: createdAt.toISOString(),
			mergedAt: subDays(parseISO(deployment.timestamp), Math.random() * 2).toISOString(),
			baseBranch: 'main',
		});
	});
	return prs;
};


// --- DORA Metrics Calculation ---

class DoraMetricsDashboard {
	private deployments: Deployment[];
	private incidents: Incident[];
	private pullRequests: PullRequest[];
	private timePeriodInDays: number;
	private teams: string[];

	constructor(deployments: Deployment[], incidents: Incident[], pullRequests: PullRequest[], timePeriodInDays: number = 90) {
		this.deployments = deployments;
		this.incidents = incidents;
		this.pullRequests = pullRequests;
		this.timePeriodInDays = timePeriodInDays;
		this.teams = [...new Set(deployments.map(d => d.team).filter((t): t is string => !!t))];
		this.filterDataByTimePeriod();
	}

	private filterDataByTimePeriod() {
		const cutoffDate = subDays(new Date(), this.timePeriodInDays);
		this.deployments = this.deployments.filter(d => parseISO(d.timestamp) >= cutoffDate);
		this.incidents = this.incidents.filter(i => parseISO(i.startTime) >= cutoffDate);
		this.pullRequests = this.pullRequests.filter(pr => pr.mergedAt && parseISO(pr.mergedAt) >= cutoffDate);
	}

	/**
	 * Deployment Frequency: How often an organization successfully releases to production.
	 * Elite: Multiple deploys per day
	 * High: Between once per day and once per week
	 * Medium: Between once per week and once per month
	 * Low: Less than once per month
	 */
	getDeploymentFrequency(): { frequency: number; rating: string } {
		if (this.deployments.length === 0) {
			return { frequency: 0, rating: 'Low' };
		}
		const successfulDeployments = this.deployments.filter(d => d.result === 'success');
		const frequency = successfulDeployments.length / this.timePeriodInDays; // deployments per day

		if (frequency > 1) return { frequency, rating: 'Elite' };
		if (frequency >= 1 / 7) return { frequency, rating: 'High' };
		if (frequency >= 1 / 30) return { frequency, rating: 'Medium' };
		return { frequency, rating: 'Low' };
	}

	/**
	 * Lead Time for Changes: The amount of time it takes a commit to get into production.
	 * Elite: Less than one day
	 * High: Between one day and one week
	 * Medium: Between one week and one month
	 * Low: More than one month
	 */
	getLeadTimeForChanges(): { averageLeadTimeDays: number; rating: string } {
		const leadTimes: number[] = [];
		this.pullRequests.forEach(pr => {
			const deployment = this.deployments.find(d => d.commitSha === pr.commitSha && d.result === 'success');
			if (pr.mergedAt && deployment) {
				const leadTime = differenceInDays(parseISO(deployment.timestamp), parseISO(pr.createdAt));
				leadTimes.push(leadTime);
			}
		});

		if (leadTimes.length === 0) {
			return { averageLeadTimeDays: 0, rating: 'N/A' };
		}

		const averageLeadTimeDays = leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length;

		if (averageLeadTimeDays < 1) return { averageLeadTimeDays, rating: 'Elite' };
		if (averageLeadTimeDays <= 7) return { averageLeadTimeDays, rating: 'High' };
		if (averageLeadTimeDays <= 30) return { averageLeadTimeDays, rating: 'Medium' };
		return { averageLeadTimeDays, rating: 'Low' };
	}

	/**
	 * Mean Time to Recovery (MTTR): How long it takes an organization to recover from a failure in production.
	 * Elite: Less than one hour
	 * High: Less than one day
	 * Medium: Between one day and one week
	 * Low: More than one week
	 */
	getMeanTimeToRecovery(): { averageRecoveryMinutes: number; rating: string } {
		const recoveryTimes: number[] = [];
		const failureIncidents = this.incidents.filter(i => i.endTime);

		failureIncidents.forEach(incident => {
			if (incident.endTime) {
				const recoveryTime = differenceInMinutes(parseISO(incident.endTime), parseISO(incident.startTime));
				recoveryTimes.push(recoveryTime);
			}
		});

		if (recoveryTimes.length === 0) {
			return { averageRecoveryMinutes: 0, rating: 'N/A' };
		}

		const averageRecoveryMinutes = recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length;
		const averageRecoveryHours = averageRecoveryMinutes / 60;

		if (averageRecoveryHours < 1) return { averageRecoveryMinutes, rating: 'Elite' };
		if (averageRecoveryHours < 24) return { averageRecoveryMinutes, rating: 'High' };
		if (averageRecoveryHours < 168) return { averageRecoveryMinutes, rating: 'Medium' };
		return { averageRecoveryMinutes, rating: 'Low' };
	}

	/**
	 * Change Failure Rate: The percentage of deployments causing a failure in production.
	 * Elite: 0-15%
	 * High: 16-30%
	 * Medium: 31-45%
	 * Low: 46-60%
	 */
	getChangeFailureRate(): { rate: number; rating: string } {
		if (this.deployments.length === 0) {
			return { rate: 0, rating: 'N/A' };
		}
		const failedDeployments = this.deployments.filter(d => d.result === 'failure').length;
		const rate = (failedDeployments / this.deployments.length) * 100;

		if (rate <= 15) return { rate, rating: 'Elite' };
		if (rate <= 30) return { rate, rating: 'High' };
		if (rate <= 45) return { rate, rating: 'Medium' };
		return { rate, rating: 'Low' };
	}

	/**
	 * Calculates deployment trends over a specified period.
	 * @param intervalDays The interval in days to group deployments by (e.g., 7 for weekly).
	 * @returns An array of objects with date and deployment count.
	 */
	getDeploymentTrend(intervalDays: number = 7): { date: string, count: number }[] {
		const trend: { [key: string]: number } = {};
		const sortedDeployments = [...this.deployments].sort((a, b) => parseISO(a.timestamp).getTime() - parseISO(b.timestamp).getTime());

		if (sortedDeployments.length === 0) {
			return [];
		}

		const firstDate = parseISO(sortedDeployments[0]!.timestamp);
		const lastDate = new Date();

		let currentDate = new Date(firstDate);
		while (currentDate <= lastDate) {
			const key = currentDate.toISOString().split('T')[0];
			if (key) {
				trend[key] = 0;
			}
			currentDate.setDate(currentDate.getDate() + intervalDays);
		}

		for (const deployment of sortedDeployments) {
			const depDate = parseISO(deployment.timestamp);
			for (const key in trend) {
				const intervalStart = parseISO(key);
				const intervalEnd = new Date(intervalStart);
				intervalEnd.setDate(intervalEnd.getDate() + intervalDays);
				if (depDate >= intervalStart && depDate < intervalEnd) {
					if (trend[key] !== undefined) {
						trend[key]++;
					}
					break;
				}
			}
		}

		return Object.entries(trend).map(([date, count]) => ({ date, count }));
	}

	/**
	 * Calculates percentiles for lead time for changes.
	 * @returns An object with 50th, 75th, and 95th percentile lead times.
	 */
	getLeadTimePercentiles(): { p50: any, p75: any, p95: any } {
		const leadTimes: number[] = [];
		this.pullRequests.forEach(pr => {
			const deployment = this.deployments.find(d => d.commitSha === pr.commitSha && d.result === 'success');
			if (pr.mergedAt && deployment) {
				const leadTime = differenceInDays(parseISO(deployment.timestamp), parseISO(pr.createdAt));
				leadTimes.push(leadTime);
			}
		});

		if (leadTimes.length === 0) {
			return { p50: 0, p75: 0, p95: 0 };
		}

		leadTimes.sort((a, b) => a - b);

		const p50Index = Math.floor(leadTimes.length * 0.5);
		const p75Index = Math.floor(leadTimes.length * 0.75);
		const p95Index = Math.floor(leadTimes.length * 0.95);

		return {
			p50: leadTimes[p50Index] ?? 0,
			p75: leadTimes[p75Index] ?? 0,
			p95: leadTimes[p95Index] ?? 0,
		};
	}

	/**
	 * Groups all DORA metrics by team.
	 * @returns A map where keys are team names and values are their DORA metrics summaries.
	 */
	getMetricsByTeam(): Map<string, ReturnType<typeof this.getMetricsSummary>> {
		const metricsByTeam = new Map<string, ReturnType<typeof this.getMetricsSummary>>();

		for (const team of this.teams) {
			const teamDeployments = this.deployments.filter(d => d.team === team);
			const teamIncidents = this.incidents.filter(i => {
				const dep = teamDeployments.find(d => d.id === i.deploymentId);
				return !!dep;
			});
			const teamPrs = this.pullRequests.filter(pr => {
				const dep = teamDeployments.find(d => d.commitSha === pr.commitSha);
				return !!dep;
			});

			const teamDashboard = new DoraMetricsDashboard(teamDeployments, teamIncidents, teamPrs, this.timePeriodInDays);
			metricsByTeam.set(team, teamDashboard.getMetricsSummary());
		}

		return metricsByTeam;
	}

	getMetricsSummary() {
		return {
			deploymentFrequency: this.getDeploymentFrequency(),
			leadTimeForChanges: this.getLeadTimeForChanges(),
			meanTimeToRecovery: this.getMeanTimeToRecovery(),
			changeFailureRate: this.getChangeFailureRate(),
		};
	}

	getTimePeriod() {
		return this.timePeriodInDays;
	}
}

// --- Example Usage ---
const deployments = generateDeployments(100);
const incidents = generateIncidents(deployments);
const pullRequests = generatePullRequests(deployments);

const dashboard = new DoraMetricsDashboard(deployments, incidents, pullRequests);
const summary = dashboard.getMetricsSummary();

console.log("DORA Metrics Summary (Last 90 Days)");
console.log("=====================================");
console.log(`Deployment Frequency: ${summary.deploymentFrequency.frequency.toFixed(2)} deploys/day (${summary.deploymentFrequency.rating})`);
console.log(`Lead Time for Changes: ${summary.leadTimeForChanges.averageLeadTimeDays.toFixed(2)} days (${summary.leadTimeForChanges.rating})`);
console.log(`Mean Time to Recovery: ${summary.meanTimeToRecovery.averageRecoveryMinutes.toFixed(2)} minutes (${summary.meanTimeToRecovery.rating})`);
console.log(`Change Failure Rate: ${summary.changeFailureRate.rate.toFixed(2)}% (${summary.changeFailureRate.rating})`);

console.log("\nLead Time Percentiles");
console.log("=====================");
const percentiles = dashboard.getLeadTimePercentiles();
console.log(`50th Percentile (Median): ${percentiles.p50} days`);
console.log(`75th Percentile: ${percentiles.p75} days`);
console.log(`95th Percentile: ${percentiles.p95} days`);

console.log("\nWeekly Deployment Trend");
console.log("=======================");
const trend = dashboard.getDeploymentTrend(7);
trend.forEach(t => console.log(`${t.date}: ${t.count} deployments`));

console.log("\nMetrics By Team");
console.log("===============");
const byTeam = dashboard.getMetricsByTeam();
byTeam.forEach((metrics, team) => {
	console.log(`\n--- Team: ${team} ---`);
	console.log(`  Deployment Frequency: ${metrics.deploymentFrequency.frequency.toFixed(2)} deploys/day (${metrics.deploymentFrequency.rating})`);
	console.log(`  Lead Time for Changes: ${metrics.leadTimeForChanges.averageLeadTimeDays.toFixed(2)} days (${metrics.leadTimeForChanges.rating})`);
	console.log(`  Mean Time to Recovery: ${metrics.meanTimeToRecovery.averageRecoveryMinutes.toFixed(2)} minutes (${metrics.meanTimeToRecovery.rating})`);
	console.log(`  Change Failure Rate: ${metrics.changeFailureRate.rate.toFixed(2)}% (${metrics.changeFailureRate.rating})`);
});

// --- HTML Rendering ---

function renderMetric(title: string, value: string, rating: string, id: string): string {
	return `
		<div class="metric-card" id="${id}">
			<h3>${title}</h3>
			<p class="value">${value}</p>
			<p class="rating">Rating: <span class="rating-${rating.toLowerCase()}">${rating}</span></p>
		</div>
	`;
}

function renderTrendChart(trendData: { date: string, count: number }[]): string {
	const maxValue = Math.max(...trendData.map(d => d.count), 0);
	const chartBars = trendData.map(d => {
		const percentage = maxValue > 0 ? (d.count / maxValue) * 100 : 0;
		return `
			<div class="chart-bar-container"
                 onmouseover="showTooltip(event, '${d.date}', ${d.count})"
                 onmouseout="hideTooltip()">
				<div class="chart-bar" style="height: ${percentage}%;"></div>
				<span class="chart-label">${d.date}</span>
			</div>
		`;
	}).join('');

	return `
		<div class="chart-container">
			<h2>Deployment Trend</h2>
			<div class="chart">
				${chartBars}
			</div>
			<div id="tooltip" class="tooltip" style="display:none;"></div>
		</div>
	`;
}

function renderTeamMetrics(teamMetrics: Map<string, ReturnType<DoraMetricsDashboard['getMetricsSummary']>>): string {
	let toggles = '<div class="team-toggles">';
	let metricsHtml = '';
	const teamData: { team: string, metrics: ReturnType<DoraMetricsDashboard['getMetricsSummary']>, teamId: string }[] = [];

	teamMetrics.forEach((metrics, team) => {
		const teamId = team.replace(/\\s+/g, '-');
		teamData.push({ team, metrics, teamId });

		toggles += `
			<label>
				<input type="checkbox" onchange="toggleTeamVisibility('${teamId}')" checked>
				${team}
			</label>
		`;
	});

	toggles += '</div>';

	// Create sort buttons
	const sortButtons = `
		<div class="sort-buttons">
			<span>Sort by:</span>
			<button onclick="sortTeams('df')">Deploy Freq</button>
			<button onclick="sortTeams('lt')">Lead Time</button>
			<button onclick="sortTeams('mttr')">MTTR</button>
			<button onclick="sortTeams('cfr')">Failure Rate</button>
		</div>
	`;

	metricsHtml = teamData.map(data => `
		<div class="team-metrics" id="team-${data.teamId}"
			 data-df="${data.metrics.deploymentFrequency.frequency}"
			 data-lt="${data.metrics.leadTimeForChanges.averageLeadTimeDays}"
			 data-mttr="${data.metrics.meanTimeToRecovery.averageRecoveryMinutes}"
			 data-cfr="${data.metrics.changeFailureRate.rate}">
			<h3>Team: ${data.team}</h3>
			<div class="metrics-grid">
				${renderMetric('Deployment Frequency', `${data.metrics.deploymentFrequency.frequency.toFixed(2)} d/day`, data.metrics.deploymentFrequency.rating, `df-${data.teamId}`)}
				${renderMetric('Lead Time for Changes', `${data.metrics.leadTimeForChanges.averageLeadTimeDays.toFixed(2)} days`, data.metrics.leadTimeForChanges.rating, `lt-${data.teamId}`)}
				${renderMetric('Mean Time to Recovery', `${data.metrics.meanTimeToRecovery.averageRecoveryMinutes.toFixed(2)} min`, data.metrics.meanTimeToRecovery.rating, `mttr-${data.teamId}`)}
				${renderMetric('Change Failure Rate', `${data.metrics.changeFailureRate.rate.toFixed(2)}%`, data.metrics.changeFailureRate.rating, `cfr-${data.teamId}`)}
			</div>
		</div>
	`).join('');

	return `
		<div class="team-metrics-container">
			<h2>Metrics By Team</h2>
			${toggles}
			${sortButtons}
			<div id="teams-list">
				${metricsHtml}
			</div>
		</div>
	`;
}

function renderDashboard(
	dashboard: DoraMetricsDashboard,
	allDeployments: Deployment[],
	allIncidents: Incident[],
	allPullRequests: PullRequest[]
): string {
	const summary = dashboard.getMetricsSummary();
	const trend = dashboard.getDeploymentTrend(7);
	const byTeam = dashboard.getMetricsByTeam();

	const dashboardContent = `
		<h1>DORA Metrics Dashboard</h1>
		<div class="header-controls">
			<h2>Overall Performance (Last <span id="time-period-display">${dashboard.getTimePeriod()}</span> Days)</h2>
			<div class="time-filter">
				<span>View:</span>
				<button onclick="window.updateDashboard(30)" id="btn-30">30 Days</button>
				<button onclick="window.updateDashboard(60)" id="btn-60">60 Days</button>
				<button onclick="window.updateDashboard(90)" id="btn-90" class="active">90 Days</button>
			</div>
		</div>
		<div class="metrics-grid">
			${renderMetric('Deployment Frequency', `${summary.deploymentFrequency.frequency.toFixed(2)} d/day`, summary.deploymentFrequency.rating, 'df-overall')}
			${renderMetric('Lead Time for Changes', `${summary.leadTimeForChanges.averageLeadTimeDays.toFixed(2)} days`, summary.leadTimeForChanges.rating, 'lt-overall')}
			${renderMetric('Mean Time to Recovery', `${summary.meanTimeToRecovery.averageRecoveryMinutes.toFixed(2)} min`, summary.meanTimeToRecovery.rating, 'mttr-overall')}
			${renderMetric('Change Failure Rate', `${summary.changeFailureRate.rate.toFixed(2)}%`, summary.changeFailureRate.rating, 'cfr-overall')}
		</div>
		${renderTrendChart(trend)}
		${renderTeamMetrics(byTeam)}
	`;

	return `
		<html>
			<head>
				<title>DORA Metrics Dashboard</title>
				<style>
					body { font-family: sans-serif; background-color: #f0f2f5; color: #333; }
					.dashboard { max-width: 1200px; margin: auto; padding: 20px; }
					h1, h2 { color: #1a2b4d; }
					.header-controls { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; margin-bottom: 20px; }
					.time-filter { display: flex; align-items: center; gap: 10px; }
					.time-filter button { padding: 5px 10px; border: 1px solid #ccc; background-color: #fff; cursor: pointer; border-radius: 4px; }
					.time-filter button.active { background-color: #1a2b4d; color: white; border-color: #1a2b4d; }
					.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
					.metric-card { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
					.metric-card h3 { margin-top: 0; }
					.metric-card .value { font-size: 2em; font-weight: bold; }
					.rating { font-style: italic; }
					.rating-elite { color: #00aaff; }
					.rating-high { color: #00c853; }
					.rating-medium { color: #ffab00; }
					.rating-low { color: #d50000; }
					.chart-container { position: relative; background: white; padding: 20px; border-radius: 8px; margin-top: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
					.chart { display: flex; align-items: flex-end; height: 200px; gap: 5px; border-bottom: 1px solid #ccc; padding-top: 10px; }
					.chart-bar-container { flex: 1; text-align: center; cursor: pointer; }
					.chart-bar { background-color: #1a2b4d; width: 80%; margin: 0 auto; transition: background-color 0.2s ease-in-out; }
					.chart-bar-container:hover .chart-bar { background-color: #00aaff; }
					.chart-label { font-size: 0.8em; }
					.team-metrics-container { background: white; padding: 20px; border-radius: 8px; margin-top: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
					.team-toggles { margin-bottom: 20px; display: flex; gap: 15px; flex-wrap: wrap; }
					.team-toggles label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
					.team-metrics { margin-top: 10px; border: 1px solid #eee; padding: 15px; border-radius: 4px; }
					.sort-buttons { margin-bottom: 15px; display: flex; gap: 10px; align-items: center; }
					.sort-buttons button { padding: 5px 10px; border: 1px solid #ccc; background-color: #fff; cursor: pointer; border-radius: 4px; }
					.sort-buttons button.active { background-color: #1a2b4d; color: white; border-color: #1a2b4d; }
					.tooltip { position: fixed; display: none; background-color: rgba(0,0,0,0.8); color: white; padding: 8px 12px; border-radius: 4px; font-size: 0.9em; pointer-events: none; z-index: 100; }
				</style>
			</head>
			<body>
				<div class="dashboard" id="dashboard-container">
					${dashboardContent}
				</div>
				<script>
					// Raw data embedded for client-side interactivity
					const allDeployments = ${JSON.stringify(allDeployments)};
					const allIncidents = ${JSON.stringify(allIncidents)};
					const allPullRequests = ${JSON.stringify(allPullRequests)};

					// Make classes and functions available on the window object
					window.DoraMetricsDashboard = DoraMetricsDashboard;
					window.renderDashboard = renderDashboard;
					window.renderMetric = renderMetric;
					window.renderTrendChart = renderTrendChart;
					window.renderTeamMetrics = renderTeamMetrics;

					window.updateDashboard = function(timePeriod) {
						// Re-create the dashboard with the new time period
						const newDashboard = new window.DoraMetricsDashboard(allDeployments, allIncidents, allPullRequests, timePeriod);

						// Re-render the content
						const summary = newDashboard.getMetricsSummary();
						const trend = newDashboard.getDeploymentTrend(7);
						const byTeam = newDashboard.getMetricsByTeam();

						const newContent = \`
							<h1>DORA Metrics Dashboard</h1>
							<div class="header-controls">
								<h2>Overall Performance (Last <span id="time-period-display">\${newDashboard.getTimePeriod()}</span> Days)</h2>
								<div class="time-filter">
									<span>View:</span>
									<button onclick="window.updateDashboard(30)" id="btn-30">30 Days</button>
									<button onclick="window.updateDashboard(60)" id="btn-60">60 Days</button>
									<button onclick="window.updateDashboard(90)" id="btn-90">90 Days</button>
								</div>
							</div>
							<div class="metrics-grid">
								\${window.renderMetric('Deployment Frequency', \`\${summary.deploymentFrequency.frequency.toFixed(2)} d/day\`, summary.deploymentFrequency.rating, 'df-overall')}
								\${window.renderMetric('Lead Time for Changes', \`\${summary.leadTimeForChanges.averageLeadTimeDays.toFixed(2)} days\`, summary.leadTimeForChanges.rating, 'lt-overall')}
								\${window.renderMetric('Mean Time to Recovery', \`\${summary.meanTimeToRecovery.averageRecoveryMinutes.toFixed(2)} min\`, summary.meanTimeToRecovery.rating, 'mttr-overall')}
								\${window.renderMetric('Change Failure Rate', \`\${summary.changeFailureRate.rate.toFixed(2)}%\`, summary.changeFailureRate.rating, 'cfr-overall')}
							</div>
							\${window.renderTrendChart(trend)}
							\${window.renderTeamMetrics(byTeam)}
						\`;

						document.getElementById('dashboard-container').innerHTML = newContent;

						// Update active button
						document.querySelectorAll('.time-filter button').forEach(btn => btn.classList.remove('active'));
						const activeButton = document.getElementById('btn-' + timePeriod);
						if (activeButton) {
							activeButton.classList.add('active');
						}
					}

					function showTooltip(event, date, count) {
						const tooltip = document.getElementById('tooltip');
						if (!tooltip) return;
						tooltip.style.display = 'block';
						tooltip.innerHTML = '<strong>' + date + '</strong><br>' + count + ' deployments';

						const tooltipRect = tooltip.getBoundingClientRect();
						let x = event.clientX + 10;
						let y = event.clientY + 10;

						if (x + tooltipRect.width > window.innerWidth) {
							x = event.clientX - tooltipRect.width - 10;
						}
						if (y + tooltipRect.height > window.innerHeight) {
							y = event.clientY - tooltipRect.height - 10;
						}

						tooltip.style.left = x + 'px';
						tooltip.style.top = y + 'px';
					}

					function hideTooltip() {
						const tooltip = document.getElementById('tooltip');
						if (tooltip) {
							tooltip.style.display = 'none';
						}
					}

					function toggleTeamVisibility(teamId) {
						const teamElement = document.getElementById('team-' + teamId);
						if (teamElement) {
							teamElement.style.display = teamElement.style.display === 'none' ? 'block' : 'none';
						}
					}

					let currentSortOrder = 'desc';
					let lastSortKey = '';

					function sortTeams(key) {
						const teamsList = document.getElementById('teams-list');
						if (!teamsList) return;
						const teams = Array.from(teamsList.children);

						if (lastSortKey === key) {
							currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
						} else {
							currentSortOrder = (key === 'df') ? 'desc' : 'asc';
						}
						lastSortKey = key;

						teams.sort((a, b) => {
							const valA = parseFloat(a.dataset[key]);
							const valB = parseFloat(b.dataset[key]);

							if (currentSortOrder === 'asc') {
								return valA - valB;
							} else {
								return valB - valA;
							}
						});

						teams.forEach(team => teamsList.appendChild(team));

						document.querySelectorAll('.sort-buttons button').forEach(btn => btn.classList.remove('active'));
						const activeButton = document.querySelector('.sort-buttons button[onclick="sortTeams(\'' + key + '\')]');
						if (activeButton) {
							activeButton.classList.add('active');
						}
					}
				</script>
			</body>
		</html>
	`;
}

const dashboardHtml = renderDashboard(dashboard, deployments, incidents, pullRequests);
console.log('\n--- Rendered Dashboard HTML ---');
console.log(dashboardHtml);