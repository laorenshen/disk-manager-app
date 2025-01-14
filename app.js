const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper function to execute commands
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                reject(error.message || stderr);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

// Get partition information
app.get('/partitions', async (req, res) => {
    try {
        const output = await executeCommand('lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT');
        const lines = output.split('\n').slice(1); // Skip header
        let partitions = lines.map(line => {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                 // 使用正则表达式去除 "├─" 等多余字符
                 const name = parts[0].replace(/^[├│└─]+/g, '');
                  return { name: name, size: parts[1], fstype: parts[2], mountpoint: parts[3], shareName: '' };
            }
        }).filter(part => part);


        // Filter partitions to only include NTFS and ext4
        const filteredPartitions = partitions.filter(part => part.fstype === 'ntfs' || part.fstype === 'ext4');


        // 读取 SMB 配置文件并添加 shareName
       const shareConfFile = '/etc/samba/users/laorenshen.share.conf';
       if(fs.existsSync(shareConfFile)) {
            const shareConfContent = fs.readFileSync(shareConfFile, 'utf-8');
            const shareRegex = /\[(.*?)\][\s\S]*?path = (.*?)\n/g;
            let match;
             while ((match = shareRegex.exec(shareConfContent)) !== null) {
                const shareName = match[1];
                const sharePath = match[2].trim();
                for (const partition of filteredPartitions) {
                   const mountpointMatch =  `lsblk -o NAME,MOUNTPOINT | grep ${partition.name}`
                  const lsblkOutput = await executeCommand(mountpointMatch)
                   const mountpoint = lsblkOutput.match(/(\S+)\s+(\S+)/);
                    if(mountpoint && mountpoint.length === 3){
                        const mountPath = mountpoint[2].trim();
                           if (mountPath === sharePath) {
                                partition.shareName = shareName;
                            }
                       }
                  }
            }
         }
          res.json(filteredPartitions);
    } catch (error) {
        res.status(500).json({ error: `Failed to fetch partitions: ${error}` });
    }
});

// Mount partition
app.post('/mount', async (req, res) => {
    const { partition, mountpoint } = req.body;
    if (!partition || !mountpoint) {
        return res.status(400).json({ error: 'Missing partition or mountpoint' });
    }

    try {
        // 使用 lsblk 获取分区的完整路径
         const lsblkOutput = await executeCommand(`lsblk -o PATH,NAME | grep ${partition}`);
        const pathMatch = lsblkOutput.match(/(\S+)\s+(\S+)/);
        if (pathMatch && pathMatch.length === 3) {
            const devicePath = pathMatch[1]; // 获取完整的设备路径，比如 /dev/nvme0n1p4
            await executeCommand(`sudo mkdir -p ${mountpoint}`);
            await executeCommand(`sudo mount ${devicePath} ${mountpoint}`);
             await addFstabEntry(devicePath, mountpoint);
            res.json({ message: `Partition ${partition} mounted to ${mountpoint}` });
         } else {
            return res.status(500).json({ error: `Failed to get device path for ${partition}` });
        }
    } catch (error) {
        return res.status(500).json({ error: `Failed to mount partition: ${error}` });
    }
});

// Unmount partition
app.post('/umount', async (req, res) => {
     const { partition } = req.body;
    if (!partition) {
       return res.status(400).json({ error: 'Missing partition' });
    }

    try {
        // 使用 lsblk 获取分区的挂载点
         const lsblkOutput = await executeCommand(`lsblk -o NAME,MOUNTPOINT | grep ${partition}`);
        const mountpointMatch = lsblkOutput.match(/(\S+)\s+(\S+)/);
        if (mountpointMatch && mountpointMatch.length === 3) {
            const mountpoint = mountpointMatch[2];
            await executeCommand(`sudo umount ${mountpoint}`);
           await removeFstabEntry(partition, mountpoint);
             res.json({ message: `Partition ${partition} unmounted` });
          } else {
             res.json({message: `Partition ${partition} is not mounted`});
         }
    } catch (error) {
        return res.status(500).json({ error: `Failed to umount partition: ${error}` });
    }
});


// Fix partition (new)
app.post('/fix', async (req, res) => {
    const { partition } = req.body;
    if (!partition) {
        return res.status(400).send('error: Missing partition parameter');
    }

    try {
        // 获取分区的完整路径
        const lsblkOutput = await executeCommand(`lsblk -o PATH,NAME | grep ${partition}`);
        const pathMatch = lsblkOutput.match(/(\S+)\s+(\S+)/);
        if (pathMatch && pathMatch.length === 3) {
            const devicePath = pathMatch[1];
            try {
                await executeCommand(`sudo mount -o ro ${devicePath} /mnt`);
                await executeCommand(`sudo fsck ${devicePath}`);
                await executeCommand(`sudo umount /mnt`);
                await executeCommand(`sudo ntfsfix ${devicePath}`);
                return res.status(200).send('ok');
            } catch (fixError) {
                 return res.status(500).send(`error: ${fixError.message}`);
            }
        } else {
            return res.status(500).send('error: Failed to get device path for ${partition}');
        }
    } catch (error) {
        return res.status(500).send(`error: ${error}`);
    }
});

// SMB share partition (new)
app.post('/smbshare', async (req, res) => {
    const { partition, shareName } = req.body;
    if (!partition || !shareName) {
        return res.status(400).send('error: Missing partition or shareName');
    }

    try {
         // 1. 检查并添加 /etc/samba/smb.conf 的 include
        const smbConfPath = '/etc/samba/smb.conf';
        const includeLine = 'include = /etc/samba/users/laorenshen.share.conf';
       const smbConfContent = fs.readFileSync(smbConfPath, {encoding: 'utf-8', flag:'r'});

        if (!smbConfContent.trim().endsWith(includeLine)) {
            fs.appendFileSync(smbConfPath, `\n${includeLine}`);
          }

        // 2. 获取分区的完整路径
        const lsblkOutput = await executeCommand(`lsblk -o PATH,NAME | grep ${partition}`);
        const pathMatch = lsblkOutput.match(/(\S+)\s+(\S+)/);
         if (pathMatch && pathMatch.length === 3) {
            const devicePath = pathMatch[1];
              // 3. 创建或更新共享配置文件
              const shareConfDir = '/etc/samba/users/';
              const shareConfFile = `${shareConfDir}laorenshen.share.conf`;
               try{
                    if (!fs.existsSync(shareConfDir)) {
                     fs.mkdirSync(shareConfDir, { recursive: true });
                    }

                    const mountpointMatch = await executeCommand(`lsblk -o NAME,MOUNTPOINT | grep ${partition}`);
                     const mountpoint = mountpointMatch.match(/(\S+)\s+(\S+)/);

                    if(mountpoint && mountpoint.length === 3){
                        const mountPath = mountpoint[2];
                         
                        //  检查 shareName 是否已经存在， 如果已经存在直接返回
                        const shareConfContent =  fs.existsSync(shareConfFile) ? fs.readFileSync(shareConfFile, 'utf-8') : '';
                        const shareExists = shareConfContent.includes(`[${shareName}]`);
                         if(shareExists){
                             console.log(`Share ${shareName} already exists. Skip writing to config file.`);
                             return res.status(200).send('ok');
                         }
                         const newShareConfig = `
[${shareName}]
        path = ${mountPath}
        browseable = yes
        available = yes
        writeable = yes
        hide special files = yes
        hide unreadable = yes
        comment = System default shared folder
`;
                        console.log(`Writing to ${shareConfFile}: `, newShareConfig);
                       // 直接追加新配置，不要读取之前的配置
                      fs.appendFileSync(shareConfFile, newShareConfig);
                      res.status(200).send('ok');
                     }else{
                         return res.status(500).send(`error: Failed to get mountpoint for partition: ${partition}`);
                  }
               }catch (mkdirError) {
                return res.status(500).send(`error: Failed to create directory: ${mkdirError.message}`);
               }
        } else {
            return res.status(500).send(`error: Failed to get device path for ${partition}`);
        }
    } catch (error) {
       return res.status(500).send(`error: Failed to create SMB share: ${error}`);
    }
});

// Add entry to /etc/fstab
async function addFstabEntry(devicePath, mountpoint) {
    try {
         const blkidOutput = await executeCommand(`blkid ${devicePath}`);
        const uuidMatch = blkidOutput.match(/UUID="([^"]+)"/);
        const fsTypeMatch = blkidOutput.match(/TYPE="([^"]+)"/);
   
        if (uuidMatch && fsTypeMatch) {
           const uuid = uuidMatch[1];
          const fsType = fsTypeMatch[1];
          const fstabEntry = `UUID=${uuid}\t${mountpoint}\t${fsType}\tdefaults\t0\t0\n`;
          fs.appendFileSync('/etc/fstab', fstabEntry);
          } else {
           throw new Error(`Failed to get UUID or FSTYPE for ${devicePath}`);
        }
    } catch (e) {
        throw new Error(`Failed to add fstab entry: ${e}`);
    }
}

// Remove entry from /etc/fstab
async function removeFstabEntry(partition, mountpoint) {
  try {
      const fstabContent = fs.readFileSync('/etc/fstab', 'utf-8');
    const updatedFstab = fstabContent
       .split('\n')
       .filter(line => {
            const trimmedLine = line.trim();
            const regex = new RegExp(`^UUID=[\\w\\-]+[\\s\\t]+${mountpoint}[\\s\\t]`);
            const match =  trimmedLine.match(regex);
           return !match;
        })
         .join('\n');
      fs.writeFileSync('/etc/fstab', updatedFstab);
  } catch (error) {
    throw new Error(`Failed to remove fstab entry: ${error}`);
  }
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
