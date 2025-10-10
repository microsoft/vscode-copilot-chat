/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Embedding, EmbeddingVector } from './embeddingsComputer';

export interface Node<T> {
	readonly value: T;
	readonly embedding: Embedding;
}

export interface Cluster<T> {
	readonly id: string;
	readonly nodes: readonly Node<T>[];
	readonly centroid: EmbeddingVector;
}

export interface GroupingOptions {
	/** Similarity percentile to use for threshold (92-96 recommended). Default: 94 */
	readonly similarityPercentile?: number;
	/** Minimum cluster size. Smaller clusters become singletons. Default: 2 */
	readonly minClusterSize?: number;
	/** Threshold for inserting new nodes into existing clusters. Default: same as clustering threshold */
	readonly insertThreshold?: number;
}

/**
 * Groups embeddings using cosine similarity thresholding and connected components.
 *
 * This approach builds a similarity graph by connecting embeddings above a threshold,
 * then finds connected components as clusters. It automatically determines the number
 * of clusters and handles outliers naturally.
 */
export class EmbeddingsGrouper<T> {
	private nodes: Node<T>[] = [];
	private clusters: Cluster<T>[] = [];
	private nodeToClusterId = new Map<Node<T>, string>();
	private clusterCounter = 0;
	private normalizedEmbeddings = new Map<Node<T>, EmbeddingVector>();
	private cachedSimilarities: number[] | undefined;
	private readonly options: {
		similarityPercentile: number;
		minClusterSize: number;
		insertThreshold?: number;
	};

	constructor(options?: GroupingOptions) {
		this.options = {
			similarityPercentile: 94,
			minClusterSize: 2,
			...options,
		};
	}

	/**
	 * Add a node to the grouper. Will attempt to assign to existing cluster
	 * or create a new singleton cluster.
	 */
	addNode(node: Node<T>): void {
		this.nodes.push(node);
		// Cache normalized embedding for this node
		this.normalizedEmbeddings.set(node, this.normalizeVector(node.embedding.value));
		// Invalidate cached similarities since we added a node
		this.cachedSimilarities = undefined;

		// If we have existing clusters, try to insert into the best matching one
		if (this.clusters.length > 0) {
			const insertThreshold = this.options.insertThreshold ?? this.getLastUsedThreshold();
			const bestCluster = this.findBestClusterForNode(node, insertThreshold);

			if (bestCluster) {
				this.addNodeToCluster(node, bestCluster);
				return;
			}
		}

		// Create new singleton cluster
		this.createSingletonCluster(node);
	}

	/**
	 * Add multiple nodes efficiently in batch. This is much more efficient than
	 * calling addNode() multiple times as it defers clustering until all nodes are added.
	 *
	 * @param nodes Array of nodes to add
	 * @param reclusterAfter Whether to recluster after adding all nodes. Default: true
	 */
	addNodes(nodes: Node<T>[], reclusterAfter: boolean = true): void {
		if (nodes.length === 0) {
			return;
		}

		// Batch add all nodes and cache their normalized embeddings
		for (const node of nodes) {
			this.nodes.push(node);
		}
		// Invalidate cached similarities since we added nodes
		this.cachedSimilarities = undefined;

		if (reclusterAfter) {
			// Perform full reclustering which is more efficient for bulk operations
			this.recluster();
		} else {
			// Create singleton clusters for all new nodes (fast path when clustering is deferred)
			for (const node of nodes) {
				this.createSingletonCluster(node);
			}
		}
	}

	/**
	 * Remove a node from the grouper. May cause cluster splits or deletions.
	 */
	removeNode(node: Node<T>): boolean {
		const nodeIndex = this.nodes.indexOf(node);
		if (nodeIndex === -1) {
			return false;
		}

		this.nodes.splice(nodeIndex, 1);
		// Clean up cached normalized embedding
		this.normalizedEmbeddings.delete(node);
		// Invalidate cached similarities since we removed a node
		this.cachedSimilarities = undefined;

		const clusterId = this.nodeToClusterId.get(node);
		if (clusterId) {
			this.nodeToClusterId.delete(node);
			this.removeNodeFromCluster(node, clusterId);
		}

		return true;
	}

	/**
	 * Perform full reclustering of all nodes. Use when embeddings have changed
	 * significantly or when incremental updates aren't sufficient.
	 */
	recluster(): void {
		if (this.nodes.length === 0) {
			this.clusters = [];
			this.nodeToClusterId.clear();
			return;
		}

		// Clear existing clusters
		this.clusters = [];
		this.nodeToClusterId.clear();

		// Build similarity graph using adaptive threshold
		const threshold = this.computeAdaptiveThreshold();
		const adjacencyList = this.buildSimilarityGraph(threshold);

		// Find connected components
		const components = this.findConnectedComponents(adjacencyList);

		// Create clusters from components
		this.createClustersFromComponents(components);
	}

	/**
	 * Get all current clusters
	 */
	getClusters(): readonly Cluster<T>[] {
		return this.clusters;
	}

	/**
	 * Get the cluster containing a specific node
	 */
	getClusterForNode(node: Node<T>): Cluster<T> | undefined {
		const clusterId = this.nodeToClusterId.get(node);
		return clusterId ? this.clusters.find(c => c.id === clusterId) : undefined;
	}

	private lastUsedThreshold = 0.8; // Fallback default

	private getLastUsedThreshold(): number {
		return this.lastUsedThreshold;
	}

	/**
	 * Compute adaptive threshold based on similarity distribution percentile
	 */
	private computeAdaptiveThreshold(): number {
		return this.computeThresholdForPercentile(this.options.similarityPercentile);
	}

	/**
	 * Compute threshold for a specific percentile using cached similarities
	 */
	private computeThresholdForPercentile(percentile: number): number {
		if (this.nodes.length < 2) {
			return 0.8; // Fallback for small datasets
		}

		const similarities = this.getSimilarities();
		if (similarities.length === 0) {
			return 0.8;
		}

		// Find percentile (similarities are already sorted)
		const index = Math.floor((percentile / 100) * similarities.length);
		const threshold = similarities[Math.min(index, similarities.length - 1)];

		this.lastUsedThreshold = threshold;
		return threshold;
	}

	/**
	 * Build adjacency list representation of similarity graph
	 */
	private buildSimilarityGraph(threshold: number): number[][] {
		const adjacencyList: number[][] = Array.from({ length: this.nodes.length }, () => []);

		for (let i = 0; i < this.nodes.length; i++) {
			for (let j = i + 1; j < this.nodes.length; j++) {
				const sim = this.cachedCosineSimilarity(this.nodes[i], this.nodes[j]);

				if (sim >= threshold) {
					adjacencyList[i].push(j);
					adjacencyList[j].push(i);
				}
			}
		}

		return adjacencyList;
	}

	/**
	 * Find connected components using DFS
	 */
	private findConnectedComponents(adjacencyList: number[][]): number[][] {
		const visited = new Set<number>();
		const components: number[][] = [];

		for (let i = 0; i < this.nodes.length; i++) {
			if (visited.has(i)) {
				continue;
			}

			const component: number[] = [];
			const stack = [i];

			while (stack.length > 0) {
				const node = stack.pop()!;
				if (visited.has(node)) {
					continue;
				}

				visited.add(node);
				component.push(node);

				// Add unvisited neighbors to stack
				for (const neighbor of adjacencyList[node]) {
					if (!visited.has(neighbor)) {
						stack.push(neighbor);
					}
				}
			}

			components.push(component);
		}

		return components;
	}

	/**
	 * Create clusters from connected components
	 */
	private createClustersFromComponents(components: number[][]): void {
		const minSize = this.options.minClusterSize;

		for (const component of components) {
			// Filter small components based on minimum cluster size
			if (component.length < minSize) {
				// Create singleton clusters for small components
				for (const nodeIndex of component) {
					this.createSingletonCluster(this.nodes[nodeIndex]);
				}
			} else {
				// Create regular cluster
				const clusterNodes = component.map(i => this.nodes[i]);
				this.createCluster(clusterNodes);
			}
		}
	}

	/**
	 * Find the best existing cluster for a new node
	 */
	private findBestClusterForNode(node: Node<T>, threshold: number): Cluster<T> | undefined {
		let bestCluster: Cluster<T> | undefined;
		let bestSimilarity = -1;

		for (const cluster of this.clusters) {
			const similarity = this.dotProduct(
				this.getNormalizedEmbedding(node),
				cluster.centroid
			);
			if (similarity >= threshold && similarity > bestSimilarity) {
				bestSimilarity = similarity;
				bestCluster = cluster;
			}
		}

		return bestCluster;
	}

	/**
	 * Add node to existing cluster and update centroid
	 */
	private addNodeToCluster(node: Node<T>, cluster: Cluster<T>): void {
		const updatedNodes = [...cluster.nodes, node];
		const updatedCentroid = this.computeCentroid(updatedNodes.map(n => n.embedding.value));

		const updatedCluster: Cluster<T> = {
			...cluster,
			nodes: updatedNodes,
			centroid: updatedCentroid
		};

		// Update clusters array
		const clusterIndex = this.clusters.indexOf(cluster);
		this.clusters[clusterIndex] = updatedCluster;

		this.nodeToClusterId.set(node, cluster.id);
	}

	/**
	 * Remove node from cluster and handle potential cluster deletion
	 */
	private removeNodeFromCluster(node: Node<T>, clusterId: string): void {
		const clusterIndex = this.clusters.findIndex(c => c.id === clusterId);
		if (clusterIndex === -1) {
			return;
		}

		const cluster = this.clusters[clusterIndex];
		const updatedNodes = cluster.nodes.filter(n => n !== node);

		if (updatedNodes.length === 0) {
			// Remove empty cluster
			this.clusters.splice(clusterIndex, 1);
		} else {
			// Update cluster with remaining nodes
			const updatedCentroid = this.computeCentroid(updatedNodes.map(n => n.embedding.value));
			const updatedCluster: Cluster<T> = {
				...cluster,
				nodes: updatedNodes,
				centroid: updatedCentroid
			};
			this.clusters[clusterIndex] = updatedCluster;

			// Update node mappings for remaining nodes
			for (const remainingNode of updatedNodes) {
				this.nodeToClusterId.set(remainingNode, clusterId);
			}
		}
	}

	/**
	 * Create a new cluster from nodes
	 */
	private createCluster(nodes: Node<T>[]): void {
		const id = `cluster_${this.clusterCounter++}`;
		const centroid = this.computeCentroid(nodes.map(n => n.embedding.value));

		const cluster: Cluster<T> = {
			id,
			nodes,
			centroid
		};

		this.clusters.push(cluster);

		for (const node of nodes) {
			this.nodeToClusterId.set(node, id);
		}
	}

	/**
	 * Create a singleton cluster for a single node
	 */
	private createSingletonCluster(node: Node<T>): void {
		this.createCluster([node]);
	}

	/**
	 * Compute centroid (mean) of embedding vectors
	 */
	private computeCentroid(embeddings: EmbeddingVector[]): EmbeddingVector {
		if (embeddings.length === 0) {
			return [];
		}

		if (embeddings.length === 1) {
			return [...embeddings[0]]; // Copy to avoid mutations
		}

		const dimensions = embeddings[0].length;
		const centroid = new Array(dimensions).fill(0);

		// Sum all embeddings
		for (const embedding of embeddings) {
			for (let i = 0; i < dimensions; i++) {
				centroid[i] += embedding[i];
			}
		}

		// Divide by count to get mean
		for (let i = 0; i < dimensions; i++) {
			centroid[i] /= embeddings.length;
		}

		// L2 normalize the centroid
		return this.normalizeVector(centroid);
	}

	/**
	 * Gets the sorted list of pairwise similarities between all nodes.
	 * The returned list is ordered by similarity, NOT in any particular node order.
	 */
	private getSimilarities() {
		if (this.cachedSimilarities) {
			return this.cachedSimilarities;
		}

		const similarities: number[] = [];

		// Compute all pairwise similarities (upper triangle only)
		for (let i = 0; i < this.nodes.length; i++) {
			for (let j = i + 1; j < this.nodes.length; j++) {
				const sim = this.cachedCosineSimilarity(this.nodes[i], this.nodes[j]);
				similarities.push(sim);
			}
		}

		// Sort for efficient percentile lookups
		similarities.sort((a, b) => a - b);
		this.cachedSimilarities = similarities;
		return this.cachedSimilarities;
	}

	/**
	 * Optimize clustering by finding the best similarity percentile that results in
	 * a target number of clusters or fewer.
	 *
	 * @param maxClusters Maximum desired number of clusters
	 * @param minPercentile Minimum percentile to try (default: 80)
	 * @param maxPercentile Maximum percentile to try (default: 99)
	 * @param precision How precise the search should be (default: 1 for 1% precision)
	 * @returns The optimal percentile found and resulting cluster count
	 */
	tuneThresholdForTargetClusters(
		maxClusters: number,
		minPercentile: number = 80,
		maxPercentile: number = 99,
		precision: number = 1
	): { percentile: number; clusterCount: number; threshold: number } {
		if (this.nodes.length === 0) {
			return { percentile: 94, clusterCount: 0, threshold: 0.8 };
		}

		let bestPercentile = minPercentile;
		let bestClusterCount = this.nodes.length; // Worst case: all singletons
		let bestThreshold = 0.8;

		// Binary search for optimal percentile
		let low = minPercentile;
		let high = maxPercentile;

		while (high - low > precision) {
			const mid = Math.floor((low + high) / 2);
			const threshold = this.computeThresholdForPercentile(mid);
			const clusterCount = this.countClustersForThreshold(threshold);

			if (clusterCount <= maxClusters) {
				// This percentile works, but maybe we can go lower (more clusters)
				bestPercentile = mid;
				bestClusterCount = clusterCount;
				bestThreshold = threshold;
				high = mid;
			} else {
				// Too many clusters, need higher percentile (stricter threshold)
				low = mid + precision;
			}
		}

		return {
			percentile: bestPercentile,
			clusterCount: bestClusterCount,
			threshold: bestThreshold
		};
	}

	/**
	 * Apply a specific similarity percentile and recluster
	 *
	 * @param percentile The similarity percentile to use (80-99)
	 */
	applyPercentileAndRecluster(percentile: number): void {
		// Temporarily override the percentile option
		const originalPercentile = this.options.similarityPercentile;
		(this.options as any).similarityPercentile = percentile;

		try {
			this.recluster();
		} finally {
			// Restore original percentile
			(this.options as any).similarityPercentile = originalPercentile;
		}
	}

	/**
	 * Count how many clusters would result from a given threshold without actually clustering
	 */
	private countClustersForThreshold(threshold: number): number {
		if (this.nodes.length === 0) {
			return 0;
		}

		// Build adjacency list with the given threshold
		const adjacencyList: number[][] = Array.from({ length: this.nodes.length }, () => []);

		for (let i = 0; i < this.nodes.length; i++) {
			for (let j = i + 1; j < this.nodes.length; j++) {
				const sim = this.cachedCosineSimilarity(this.nodes[i], this.nodes[j]);
				if (sim >= threshold) {
					adjacencyList[i].push(j);
					adjacencyList[j].push(i);
				}
			}
		}

		// Count connected components
		const visited = new Set<number>();
		let componentCount = 0;

		for (let i = 0; i < this.nodes.length; i++) {
			if (visited.has(i)) {
				continue;
			}

			// Found a new component
			componentCount++;
			const stack = [i];

			while (stack.length > 0) {
				const node = stack.pop()!;
				if (visited.has(node)) {
					continue;
				}

				visited.add(node);

				// Add unvisited neighbors
				for (const neighbor of adjacencyList[node]) {
					if (!visited.has(neighbor)) {
						stack.push(neighbor);
					}
				}
			}
		}

		return componentCount;
	}

	/**
	 * Get cached normalized embedding for a node
	 */
	private getNormalizedEmbedding(node: Node<T>): EmbeddingVector {
		let normalized = this.normalizedEmbeddings.get(node);
		if (!normalized) {
			normalized = this.normalizeVector(node.embedding.value);
			this.normalizedEmbeddings.set(node, normalized);
		}
		return normalized;
	}

	/**
	 * Compute cosine similarity using cached normalized embeddings
	 */
	private cachedCosineSimilarity(nodeA: Node<T>, nodeB: Node<T>): number {
		const normA = this.getNormalizedEmbedding(nodeA);
		const normB = this.getNormalizedEmbedding(nodeB);
		return this.dotProduct(normA, normB);
	}

	/**
	 * Optimized dot product computation
	 */
	private dotProduct(a: EmbeddingVector, b: EmbeddingVector): number {
		let dotProduct = 0;
		const len = Math.min(a.length, b.length);
		// Unroll loop for better performance on small vectors
		let i = 0;
		for (; i < len - 3; i += 4) {
			dotProduct += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
		}
		// Handle remaining elements
		for (; i < len; i++) {
			dotProduct += a[i] * b[i];
		}
		return dotProduct;
	}

	/**
	 * L2 normalize a vector
	 */
	private normalizeVector(vector: EmbeddingVector): EmbeddingVector {
		const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));

		if (magnitude === 0) {
			return vector.slice(); // Return copy of zero vector
		}

		return vector.map(val => val / magnitude);
	}
}
