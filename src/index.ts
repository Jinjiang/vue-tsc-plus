import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { run as vueTscRun } from 'vue-tsc'
import { compile as compileVueSFC } from 'vue-simple-compiler'

// Track file descriptor to file path mappings
const fdToPath = new Map<number, string>()

// Cache for tsconfig lookups
const tsconfigCache = new Map<string, { outDir: string; rootDir: string; sourceMap: boolean }>()

function findTsConfig(filePath: string): string | null {
	let dir = path.dirname(filePath)
	while (dir !== path.dirname(dir)) {
		const tsconfigPath = path.join(dir, 'tsconfig.json')
		if (fs.existsSync(tsconfigPath)) {
			return tsconfigPath
		}
		dir = path.dirname(dir)
	}
	return null
}

function getTsConfigPaths(filePath: string): { outDir: string; rootDir: string; sourceMap: boolean } | null {
	const tsconfigPath = findTsConfig(filePath)
	if (!tsconfigPath) return null

	if (tsconfigCache.has(tsconfigPath)) {
		return tsconfigCache.get(tsconfigPath)!
	}

	try {
		const tsconfigContent = fs.readFileSync(tsconfigPath, 'utf-8')
		// Remove comments and parse JSON
		const jsonContent = tsconfigContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
		const tsconfig = JSON.parse(jsonContent)
		const compilerOptions = tsconfig.compilerOptions || {}
		
		const projectRoot = path.dirname(tsconfigPath)
		const outDir = compilerOptions.outDir 
			? path.resolve(projectRoot, compilerOptions.outDir)
			: projectRoot
		const rootDir = compilerOptions.rootDir 
			? path.resolve(projectRoot, compilerOptions.rootDir)
			: projectRoot
		const sourceMap = compilerOptions.sourceMap === true

		const result = { outDir, rootDir, sourceMap }
		tsconfigCache.set(tsconfigPath, result)
		return result
	} catch (err) {
		console.error('Failed to parse tsconfig.json:', err)
		return null
	}
}

function resolveVueFilePath(jsFilePath: string): string | null {
	const paths = getTsConfigPaths(jsFilePath)
	if (!paths) {
		// Fallback: just remove .js extension
		return jsFilePath.slice(0, -3)
	}

	const { outDir, rootDir } = paths
	
	// Check if the file is in the outDir
	if (!jsFilePath.startsWith(outDir)) {
		// Not in output directory, use fallback
		return jsFilePath.slice(0, -3)
	}

	// Map from outDir to rootDir
	const relativePath = path.relative(outDir, jsFilePath)
	const vueFilePath = path.join(rootDir, relativePath).slice(0, -3) // Remove .js
	
	return vueFilePath
}

function shouldGenerateSourceMap(jsFilePath: string): boolean {
	const paths = getTsConfigPaths(jsFilePath)
	return paths ? paths.sourceMap : true // Default to true if not found
}

const nativeOpenSync = fs.openSync
fs.openSync = function (...args: Parameters<typeof fs.openSync>) {
  const fd = nativeOpenSync(...args)
  const [filePath] = args
  if (typeof filePath === 'string') {
    fdToPath.set(fd, filePath)
  }
  return fd
} as typeof fs.openSync

const nativeCloseSync = fs.closeSync
fs.closeSync = function (...args: Parameters<typeof fs.closeSync>) {
  const [fd] = args
  fdToPath.delete(fd)
  return nativeCloseSync(...args)
} as typeof fs.closeSync

const nativeWriteSync = fs.writeSync
fs.writeSync = function (...args: Parameters<typeof fs.writeSync>) {
  const [fd, data] = args
  
  // Get the file path from our tracking map
  const filePath = fdToPath.get(fd)

  // Check if this is a .vue.js file
  if (filePath && filePath.endsWith('.vue.js') && typeof data === 'string') {
    
    // Resolve the original .vue file path using tsconfig
    const vueFilePath = resolveVueFilePath(filePath)
    
    if (!vueFilePath) {
      console.error('Could not resolve Vue file path for:', filePath)
      return nativeWriteSync(...args)
    }

    try {
      if (fs.existsSync(vueFilePath)) {
        const vueCode = fs.readFileSync(vueFilePath, 'utf-8')
        const srcDir = path.dirname(vueFilePath)
        const filename = path.basename(vueFilePath)
        const sourceMap = shouldGenerateSourceMap(filePath)
        
        // Compile the Vue SFC
        const result = compileVueSFC(vueCode, {
          root: srcDir,
          filename: filename,
          autoImportCss: true,
          autoResolveImports: true,
          isProd: true,
          tsCompilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.ESNext,
            jsx: ts.JsxEmit.ReactJSX,
            sourceMap
          },
          tsRuntime: ts
        })

        if (result.errors.length > 0) {
          console.error('Errors compiling Vue SFC:', vueFilePath)
          for (const err of result.errors) {
            console.error(err)
          }
          // Fall through to write original data on error
          return nativeWriteSync(...args)
        }

        // Write the compiled JS
        const jsFileName = path.basename(filePath)
        let jsCode = result.js.code
        if (sourceMap && result.js.sourceMap) {
          jsCode += `\n//# sourceMappingURL=${jsFileName}.map`
          
          // Write source map
          const mapPath = filePath + '.map'
          const mapFd = nativeOpenSync(mapPath, 'w')
          nativeWriteSync(mapFd, JSON.stringify(result.js.sourceMap))
          nativeCloseSync(mapFd)
        }
        
        // Write CSS files if any
        for (const cssFile of result.css) {
          const cssPath = path.resolve(path.dirname(filePath), cssFile.filename)
          const cssFileName = path.basename(cssPath)
          let cssCode = cssFile.code
          if (sourceMap && cssFile.sourceMap) {
            cssCode += `\n/*# sourceMappingURL=${cssFileName}.map */`
            
            const cssMapPath = cssPath + '.map'
            const cssMapFd = nativeOpenSync(cssMapPath, 'w')
            nativeWriteSync(cssMapFd, JSON.stringify(cssFile.sourceMap))
            nativeCloseSync(cssMapFd)
          }
          const cssFd = nativeOpenSync(cssPath, 'w')
          nativeWriteSync(cssFd, cssCode)
          nativeCloseSync(cssFd)
        }
        
        // Write the compiled JS code instead of original data
        const modifiedArgs = [fd, jsCode, ...args.slice(2)] as Parameters<typeof fs.writeSync>
        return nativeWriteSync(...modifiedArgs)
      }
    } catch (err) {
      if (err instanceof Error) {
        console.error('Failed to compile Vue SFC:', err.message)
      } else {
        console.error('Failed to compile Vue SFC:', err)
      }
      // Fall through to write original data on error
    }
  }
  
  return nativeWriteSync(...args)
} as typeof fs.writeSync

function run() {
  vueTscRun()
}

export { run }
