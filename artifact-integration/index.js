const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_URL = 'git@github.com:nermury/euphonic-sessions-with-kyau-and-albert-playlists-fork-for-workflow.git';
const TEMP_DIR = path.join(__dirname, 'temp-repo');
const SOURCE_DIR = path.join(__dirname, '../artifact-preview/out-playlists');

/**
 * Execute a shell command
 */
function exec(command, cwd = TEMP_DIR) {
  try {
    console.log(`> ${command}`);
    const output = execSync(command, { 
      cwd, 
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return output;
  } catch (error) {
    console.error(`Error executing: ${command}`);
    console.error(error.message);
    throw error;
  }
}

/**
 * Copy directory recursively
 */
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Main integration function
 */
function integrateChanges() {
  console.log('🚀 Starting integration process...\n');
  
  // Generate branch name with timestamp
  const timestamp = Date.now();
  const branchName = `update-playlists-${timestamp}`;
  
  console.log(`📝 Branch name: ${branchName}\n`);
  
  // Clean up temp directory if it exists
  if (fs.existsSync(TEMP_DIR)) {
    console.log('🧹 Cleaning up existing temp directory...');
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  
  // Clone the repository
  console.log('📦 Cloning repository...');
  exec(`git clone ${REPO_URL} ${TEMP_DIR}`, __dirname);
  
  // Configure git
  console.log('\n⚙️  Configuring git...');
  exec('git config user.name "GitHub Actions Bot"');
  exec('git config user.email "github-actions[bot]@users.noreply.github.com"');
  
  // Create and checkout new branch
  console.log(`\n🌿 Creating branch: ${branchName}`);
  exec(`git checkout -b ${branchName}`);
  
  // Copy years folder
  console.log('\n📁 Copying playlists...');
  const destYearsDir = path.join(TEMP_DIR, 'years');
  
  // Remove existing years folder if it exists
  if (fs.existsSync(destYearsDir)) {
    fs.rmSync(destYearsDir, { recursive: true, force: true });
  }
  
  // Copy the new years folder
  copyDir(SOURCE_DIR, destYearsDir);
  
  const fileCount = execSync(`find ${destYearsDir} -type f | wc -l`, { encoding: 'utf8' }).trim();
  console.log(`✅ Copied ${fileCount} playlist files`);
  
  // Stage changes
  console.log('\n📌 Staging changes...');
  exec('git add years');
  
  // Check if there are changes to commit
  const status = exec('git status --porcelain');
  
  if (!status.trim()) {
    console.log('\n✨ No changes to commit. Repository is up to date!');
    
    // Clean up
    console.log('\n🧹 Cleaning up...');
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    
    return;
  }
  
  // Commit changes
  console.log('\n💾 Committing changes...');
  const commitMessage = `Update playlists - ${new Date().toISOString().split('T')[0]}`;
  exec(`git commit -m "${commitMessage}"`);
  
  // Push changes
  console.log('\n🚀 Pushing to remote...');
  exec(`git push origin ${branchName}`);
  
  console.log('\n✅ Integration complete!');
  console.log(`\n📋 Branch created: ${branchName}`);
  console.log(`\n🔗 Create a pull request at:`);
  console.log(`   https://github.com/nermury/euphonic-sessions-with-kyau-and-albert-playlists-fork-for-workflow/pull/new/${branchName}`);
  
  // Clean up
  console.log('\n🧹 Cleaning up...');
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  
  console.log('\n🎉 Done!\n');
}

// Run the integration
try {
  integrateChanges();
} catch (error) {
  console.error('\n❌ Integration failed:', error.message);
  
  // Clean up on error
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  
  process.exit(1);
}
