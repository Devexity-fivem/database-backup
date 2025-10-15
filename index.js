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


function Delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

async function zipFile(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', err => reject(err));

        archive.pipe(output);
        archive.file(inputPath, { name: path.basename(inputPath) });
        archive.finalize();
    });
}


async function performBackup() {
    try {
        backupCount++;
        const filename = `${config.database_info.database}-${backupCount}-${timestamp()}.sql`;
        const filepath = path.join(backupDir, filename);
        const zipPath = filepath.replace('.sql', '.zip');

        console.log(`[backup] Starting MySQL dump -> ${filepath}`);

        await mysqldump({
            connection: {
                host: config.database_info.host,
                user: config.database_info.user,
                password: config.database_info.password,
                database: config.database_info.database,
            },
            dumpToFile: filepath,
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
                await hook.send(embed);
                console.log('[backup] Embed sent. Uploading ZIP...');

                await hook.sendFile(zipPath);

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
    }
}


const intervalMs = (config.interval.time || 180) * 1000 * 60;
console.log(`[backup] Starting scheduled backups every ${intervalMs / 1000 / 60} minutes.`);


performBackup();
setInterval(performBackup, intervalMs);
