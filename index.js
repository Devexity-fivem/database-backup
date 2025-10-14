const mysqldump = require('mysqldump');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { Webhook, MessageBuilder } = require('discord-webhook-node');
const config = require('./config.json');

const root = GetResourcePath(GetCurrentResourceName());
const backupDir = path.join(root, 'sql');

if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`[backup] Created directory: ${backupDir}`);
}

let backupCount = 0;
let isBackupRunning = false; // Prevent overlapping backups

// === Helper Functions ===
function Delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

// === Optimized ZIP compression ===
async function zipFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        // Reduced compression level for better performance
        const archive = archiver('zip', { 
            zlib: { level: 1 } 
        });

        output.on('close', () => resolve());
        archive.on('error', err => reject(err));
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('[backup] Archive warning:', err);
            } else {
                reject(err);
            }
        });

        archive.pipe(output);
        archive.file(inputPath, { name: path.basename(inputPath) });
        archive.finalize();
    });
}

// === Optimized MySQL Dump Settings ===
async function performBackup() {
    if (isBackupRunning) {
        console.log('[backup] Skipping - backup already in progress');
        return;
    }
    
    isBackupRunning = true;
    
    try {
        backupCount++;
        const filename = `${config.database_info.database}-${backupCount}-${timestamp()}.sql`;
        const filepath = path.join(backupDir, filename);
        const zipPath = filepath.replace('.sql', '.zip');

        console.log(`[backup] Starting MySQL dump -> ${filepath}`);

        // Optimized dump settings for better performance
        await mysqldump({
            connection: {
                host: config.database_info.host,
                user: config.database_info.user,
                password: config.database_info.password,
                database: config.database_info.database,
            },
            dumpToFile: filepath,
            compress: false,
            
            mysqldumpOptions: {
                '--quick': true, 
                '--single-transaction': true, 
                '--skip-lock-tables': true, 
                '--no-tablespaces': true, 
            }
        });

        console.log(`[backup] Dump finished: ${filepath}`);

        
        await zipFile(filepath, zipPath);
        console.log(`[backup] Compressed -> ${zipPath}`);

        if (config.discord && config.discord.savetodiscord && config.discord.webhook) {
            console.log('[backup] Preparing Discord upload...');

            const hook = new Webhook(config.discord.webhook);
            const embed = new MessageBuilder()
                .setAuthor('Database Backup Complete')
                .setColor(config.discord.color || '#00AAFF')
                .addField('Database', config.database_info.database, true)
                .addField('File', path.basename(zipPath), true)
                .addField('Date', new Date().toLocaleString())
                .setFooter(config.discord.footer || 'Auto SQL Backup')
                .setTimestamp();

            try {
             
                await Promise.all([
                    hook.send(embed),
                    hook.sendFile(zipPath)
                ]);
                
                console.log('[backup] Upload complete!');
            } catch (discordErr) {
                console.error('[backup] Discord upload error:', discordErr);
            }
        }

       
        if (config.delete_after_upload) {
            try {
                fs.unlinkSync(filepath);
                fs.unlinkSync(zipPath);
                console.log(`[backup] Deleted local files: ${filename} & ${path.basename(zipPath)}`);
            } catch (err) {
                console.warn(`[backup] Cleanup failed: ${err}`);
            }
        }

    } catch (err) {
        console.error('[backup] General error:', err);
    } finally {
        isBackupRunning = false; 
    }
}


const intervalMs = (config.interval.time || 180) * 1000 * 60;
console.log(`[backup] Starting scheduled backups every ${intervalMs / 1000 / 60} minutes.`);


performBackup();
setInterval(performBackup, intervalMs);