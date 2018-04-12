'use strict'

const LineCoordinates = require('./line-coordinates.js')
const { validateNumber } = require('../validation.js')

class NodeAllocation {
  constructor (layout, layoutNodes, coordinatesFn = NodeAllocation.threeSided) {
    this.layout = layout
    this.layoutNodes = layoutNodes
    this.nodeToPosition = new Map()
    this.leaves = new Map()
    this.midPoints = new Map()
    this.roots = new Map()
    for (const layoutNode of layoutNodes.values()) {
      const node = layoutNode.node
      // Edge offset does not apply to midpoints - only leaves - hence init value is null
      const position = { units: 0, offset: null, x: 0, y: 0 }
      this.nodeToPosition.set(node, position)
      layoutNode.position = position
      const category = node.children.length ? 'midPoints' : 'leaves'
      this[category].set(node.id, layoutNode)
    }
    for (const midPoint of this.midPoints.values()) {
      if (!this.midPoints.get(midPoint.node.parentId)) {
        this.roots.set(midPoint.id, midPoint)
      }
    }
    const coordinates = coordinatesFn(this.layout, this.roots)
    this.initializeSegments(coordinates)
  }
  initializeSegments (coordinates) {
    this.segments = []
    this.total1DSpaceAvailable = 0
    for (const coordinate of coordinates) {
      const label = coordinate.label
      const line = new LineCoordinates(coordinate)
      const tail = this.segments[this.segments.length - 1]
      const begin = coordinate === coordinates[0] ? 0 : tail.end
      this.segments.push(new LinearSpaceSegment(label, begin, line))
      this.total1DSpaceAvailable += line.length
    }
  }
  static threeSided (layout, roots) {
    const { svgWidth, svgDistanceFromEdge } = layout.settings
    const { finalSvgHeight } = layout.scale
    const toLargestDiameter = (largest, rootLayoutNode) => Math.max(largest, rootLayoutNode.stem.getScaled(layout.scale).ownDiameter)
    const largestRootDiameter = [...roots.values()].reduce(toLargestDiameter, 0)
    const topOffset = svgDistanceFromEdge + Math.max(finalSvgHeight * 0.2, largestRootDiameter)
    const borders = {
      top: validateNumber(topOffset),
      bottom: validateNumber(finalSvgHeight - svgDistanceFromEdge),
      left: validateNumber(svgDistanceFromEdge),
      right: validateNumber(svgWidth - svgDistanceFromEdge)
    }
    const coordinates = [
      { label: 'LHS', x1: borders.left, y1: borders.top, x2: borders.left, y2: borders.bottom },
      { label: 'BOT', x1: borders.left, y1: borders.bottom, x2: borders.right, y2: borders.bottom },
      { label: 'RHS', x1: borders.right, y1: borders.bottom, x2: borders.right, y2: borders.top }
    ]
    return coordinates
  }
  process (placementMode = NodeAllocation.placementMode.LENGTH_CONSTRAINED) {
    this.convertTotalStemLengthsToUnits()
    this.calculate1DLinearOffsets()
    this.calculate2DLeafCoordinates()
    this.calculate2DMidpointCoordinates(placementMode)
    if (placementMode === NodeAllocation.placementMode.LENGTH_CONSTRAINED) {
      this.constrain2DLeafCoordinates()
    }
  }
  // Hierarchical (by depth) comparison narrows clumps internally and expands space between clumps.
  // This has proved to be more visually appealing than result of flat comparison.
  // Example:
  // 1.2     100
  // 1.3.4.5 500
  // 1.3.6.7 900
  // 1.3.6.8 500
  // In flat longest leaf comparison set: [2, 5, 7, 8], leaf 2 is allocated 5% of space (100/2000)
  // In longest leaf comparison set at depth=1: [2, 3], leaf 2 is allocated 10% of space (100/1000)
  // Subsets of nodes may not have a common ancestor and therefore cannot recursively traverse the tree root-up
  // Thus traversing depth by depth
  convertTotalStemLengthsToUnits () {
    // Traverse the hierarchies and index Clumps at each level
    const hierarchyLevels = new Map()
    for (const leafLayoutNode of this.leaves.values()) {
      const leaf = leafLayoutNode.node
      const stem = leafLayoutNode.stem

      const leafTotalStemLength = stem.getTotalStemLength(this.layout.scale).combined
      // Include ancestor Clumps
      const ancestors = stem.ancestors.ids.length ? stem.ancestors.ids : [leaf.parentId]
      for (let depth in ancestors) {
        depth = parseInt(depth)
        if (!hierarchyLevels.has(depth)) {
          hierarchyLevels.set(depth, new HierarchyLevel(depth))
        }
        const hierarchyLevel = hierarchyLevels.get(depth)
        // Form Clump for given node at given level
        const ancestorId = ancestors[depth]
        const ancestorAtDepth = leaf.getSameType(ancestorId)
        if (!this.midPoints.get(ancestorId)) {
          continue
        }
        if (!hierarchyLevel.clumps.has(ancestorAtDepth)) {
          const previousHierarchyLevel = hierarchyLevels.get(depth - 1)
          const parentClump = previousHierarchyLevel ? previousHierarchyLevel.clumps.get(ancestorAtDepth.getParentNode()) : null
          const ancestorClump = new Clump(ancestorAtDepth, parentClump, leafTotalStemLength)
          hierarchyLevel.clumps.set(ancestorAtDepth, ancestorClump)
          if (parentClump) {
            parentClump.childClumps.set(ancestorAtDepth, ancestorClump)
          }
          continue
        }
        // Determine which leaf is longest in the Clump
        const clumpAtDepth = hierarchyLevel.clumps.get(ancestorAtDepth)
        if (!clumpAtDepth.longestLeafLength || leafTotalStemLength > clumpAtDepth.longestLeafLength) {
          clumpAtDepth.longestLeafLength = leafTotalStemLength
        }
      }
      // Include leaf Clump
      const leafDepth = ancestors.length
      if (!hierarchyLevels.has(leafDepth)) {
        hierarchyLevels.set(leafDepth, new HierarchyLevel(leafDepth))
      }
      const hierarchyLevel = hierarchyLevels.get(leafDepth)
      const previousHierarchyLevel = hierarchyLevels.get(leafDepth - 1)
      const parentClump = previousHierarchyLevel.clumps.get(leaf.getParentNode())
      const leafClump = new Clump(leaf, parentClump, leafTotalStemLength)
      hierarchyLevel.clumps.set(leaf, leafClump)
      if (parentClump) {
        parentClump.childClumps.set(leaf, leafClump)
      }
    }

    // Determine portion of space to allocate for each node
    for (let depth = 0; depth < hierarchyLevels.size; ++depth) {
      const hierarchyLevel = hierarchyLevels.get(depth)
      hierarchyLevel.sumLongestLeafLengths()
      for (const clumpAtDepth of hierarchyLevel.clumps.values()) {
        const parentUnits = clumpAtDepth.parentClump ? clumpAtDepth.parentClump.units : 1
        const proportionFactor = clumpAtDepth.parentClump ? clumpAtDepth.parentClump.getTotalChildrenLongestLeafLength() : hierarchyLevel.longestLeafLengthSum
        const clumpUnits = parentUnits * (clumpAtDepth.longestLeafLength / proportionFactor)

        clumpAtDepth.units = clumpAtDepth.node.validateStat(clumpUnits)
        this.nodeToPosition.get(clumpAtDepth.node).units = clumpUnits
      }
    }
  }
  calculate1DLinearOffsets () {
    let currentSegment = this.segments[0]
    let currentBlock = null
    const intoOrder = (leafA, leafB) => this.layout.positioning.order.indexOf(leafA.node.id) - this.layout.positioning.order.indexOf(leafB.node.id)
    const arrangedLeaves = [...this.leaves.values()].sort(intoOrder) // To be optimized (unnecessary iterations)
    for (const leafLayoutNode of arrangedLeaves) {
      const leaf = leafLayoutNode.node
      const position = this.nodeToPosition.get(leaf)
      const allocatedSpace = position.units * this.total1DSpaceAvailable
      currentBlock = new SpaceBlock(leaf, currentBlock ? currentBlock.end : currentSegment.begin, allocatedSpace)
      position.offset = currentBlock.center
      currentSegment = this.segments.find(segment => segment.contains1DPoint(currentBlock.center))
      currentSegment.blocks.push(currentBlock)
    }
  }
  calculate2DLeafCoordinates () {
    for (const segment of this.segments) {
      for (const block of segment.blocks) {
        const position = this.nodeToPosition.get(block.node)
        const relativeOffset = block.center - segment.begin
        const { x, y } = segment.translate1DPointTo2D(relativeOffset)

        position.x = block.node.validateStat(x, 'x position')
        position.y = block.node.validateStat(y, 'y position')
      }
    }
  }
  constrain2DLeafCoordinates () {
    for (const layoutNode of this.leaves.values()) {
      const leaf = layoutNode.node
      const stem = layoutNode.stem

      const parentStem = layoutNode.parent && layoutNode.parent.stem
      const parentDiameter = parentStem ? parentStem.getScaled(this.layout.scale).ownDiameter : 0
      const position = this.nodeToPosition.get(leaf)
      const parentNode = leaf.getParentNode()
      const parentPosition = this.nodeToPosition.get(parentNode) || this.getRootPosition(parentDiameter)
      const line = new LineCoordinates({ x1: parentPosition.x, y1: parentPosition.y, x2: position.x, y2: position.y })
      const parentRadius = parentDiameter / 2
      const thisRadius = stem.getScaled(this.layout.scale).ownDiameter / 2
      const lineLength = stem.getScaled(this.layout.scale).ownBetween
      const { x, y } = line.pointAtLength(parentRadius + lineLength + thisRadius)

      position.x = leaf.validateStat(x)
      position.y = leaf.validateStat(y)
    }
  }
  calculate2DMidpointCoordinates (placementMode) {
    for (const layoutNode of this.midPoints.values()) {
      const midPoint = layoutNode.node
      const stem = layoutNode.stem

      const position = this.nodeToPosition.get(midPoint)
      if (!this.layoutNodes.get(midPoint.parentId)) {
        // TODO: spread out x's to declutter multiple top-level nodes, preferably using this.layout.positioning.order
        const rootPosition = this.getRootPosition(stem.getScaled(this.layout.scale).ownDiameter)
        position.x = midPoint.validateStat(rootPosition.x)
        position.y = midPoint.validateStat(rootPosition.y)
        continue
      }
      const parentStem = layoutNode.parent.stem
      const ownLeavesInSubset = stem.leaves.ids.filter(leafId => this.leaves.has(leafId))
      const leafPositions = ownLeavesInSubset.map(leafId => this.nodeToPosition.get(this.leaves.get(leafId).node))
      const leafCenter = leafPositions.reduce((combinedPosition, nodePosition) => {
        return {
          x: midPoint.validateStat(combinedPosition.x + nodePosition.x),
          y: midPoint.validateStat(combinedPosition.y + nodePosition.y)
        }
      }, { x: 0, y: 0 })

      midPoint.validateStat(leafPositions.length, `leafCenter division`, { aboveZero: true })
      leafCenter.x /= leafPositions.length
      leafCenter.y /= leafPositions.length

      const parentNode = midPoint.getParentNode()
      const parentPosition = this.nodeToPosition.get(parentNode)
      switch (placementMode) {
        case NodeAllocation.placementMode.LENGTH_CONSTRAINED:
          const line = new LineCoordinates({ x1: parentPosition.x, y1: parentPosition.y, x2: leafCenter.x, y2: leafCenter.y })

          const parentRadius = parentNode.validateStat(parentStem.getScaled(this.layout.scale).ownDiameter / 2)
          const thisRadius = midPoint.validateStat(stem.getScaled(this.layout.scale).ownDiameter / 2)
          const lineLength = midPoint.validateStat(stem.getScaled(this.layout.scale).ownBetween)

          const { x, y } = line.pointAtLength(parentRadius + lineLength + thisRadius)
          position.x = midPoint.validateStat(x)
          position.y = midPoint.validateStat(y)
          break
        case NodeAllocation.placementMode.SPIDER:
          const combinedCenter = {
            x: leafCenter.x + parentPosition.x / 2,
            y: leafCenter.y + parentPosition.y / 2
          }
          position.x = midPoint.validateStat(combinedCenter.x)
          position.y = midPoint.validateStat(combinedCenter.y)
          break
      }
    }
  }
  getRootPosition (nodeDiameter) {
    return {
      x: this.layout.settings.svgWidth / 2,
      y: this.layout.settings.svgDistanceFromEdge + (nodeDiameter / 2)
    }
  }
  static get placementMode () {
    return {
      LENGTH_CONSTRAINED: 'LENGTH_CONSTRAINED',
      SPIDER: 'SPIDER'
    }
  }
}

class HierarchyLevel {
  constructor (depth) {
    this.depth = depth
    this.clumps = new Map()
  }
  sumLongestLeafLengths () {
    this.longestLeafLengthSum = [...this.clumps.values()].reduce((total, clump) => total + clump.longestLeafLength, 0)
  }
}

class Clump {
  constructor (node, parentClump, longestLeafLength) {
    this.parentClump = parentClump
    this.node = node
    this.childClumps = new Map()
    this.longestLeafLength = longestLeafLength
  }
  getTotalChildrenLongestLeafLength () {
    return [...this.childClumps.values()].reduce((total, clump) => total + clump.longestLeafLength, 0)
  }
}

class LinearSpaceSegment {
  constructor (label, begin, line) {
    this.label = label
    this.line = line
    this.begin = begin
    this.end = begin + line.length
    // SpaceBlock may span across multiple LinearSpaceSegments, however it will belong to the one which contains its center
    this.blocks = []
  }
  contains1DPoint (offset) {
    return this.begin < offset && offset < this.end
  }
  translate1DPointTo2D (relativeOffset) {
    return this.line.pointAtLength(relativeOffset)
  }
}

class SpaceBlock {
  constructor (node, begin, length) {
    this.node = node
    this.begin = begin
    this.end = begin + length
    this.center = begin + (length / 2)
  }
}

// TODO: debugInspect moreless like this:
//  LHS                            BOT                    RHS
// [------.---------.------------][-----------.---------][--------------.-------.------]
//        9         12                        15                        10      8

// 1.9                 LHS (o=250, u=0.43, x=0, y=250)      [------.----
// 1.2.3.4.12          LHS (o=600, u=0.43, x=0, y=600)      -----.-------
// 1.2.3.5.11.13.14.15 BOT (o=1500, u=0.43, x=500, y=1000)  -----][-----------.---------][-------
// 1.2.6.7.10          RHS (o=1750, u=0.43, x=1000, y=750)  -------.----
// 1.8                 RHS (o=2750, u=0.43, x=1000, y=250)  ---.------]

module.exports = NodeAllocation
