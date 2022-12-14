const Channel = Router.resolve('core/Channel');
const {ListBucketsCommand, CreateBucketCommand, DeleteBucketCommand, PutBucketAclCommand} = require('@aws-sdk/client-s3');
const S3Helper = Router.resolve('helper/S3Helper');
const fs = require("fs-extra");
const {spawn} = require('child_process');

class BucketsChannel extends Channel {

    async getBuckets(profile) {

        const s3 = S3Helper.getS3(profile);

        const response = await s3.send(new ListBucketsCommand({}));

        return response.Buckets;
    }

    async getBucketsWithAcl(profile) {

        const s3 = S3Helper.getS3(profile);

        const response = await s3.send(new ListBucketsCommand({}));

        return await Promise.all(response.Buckets.map(async (bucket) => {

            bucket.IsPublic = await S3Helper.isPublicBucket(s3, bucket.Name);

            return bucket;

        }));

    }

    async createBucket(profile, bucketName, acl) {

        const s3 = S3Helper.getS3(profile);

        let exist = await S3Helper.checkExistBucket(s3, bucketName);

        if (exist) {
            throw {Code: "ExistBucket"}
        }

        const data = await s3.send(
            new CreateBucketCommand({
                Bucket: bucketName,
                ACL: acl // 'private' | 'public-read'
            })
        );

    }

    async deleteBucket(profile, bucketName) {

        const s3 = S3Helper.getS3(profile);

        await s3.send(new DeleteBucketCommand({Bucket: bucketName}));

    }

    async setBucketIsPublic(profile, bucketName, isPublic){

        const s3 = S3Helper.getS3(profile);

        const response = await s3.send(
            new PutBucketAclCommand({
                Bucket: bucketName,
                ACL: isPublic ? 'public-read' : 'private'
            })
        );

    }

    async syncBucket(sourceProfile, sourceBucketName, destProfile, destBucketName) {

        GlobalData.AbortSignal = false;
        GlobalData.AppInProcess = true;

        const self = this;
        const maxSingleUploadSize = 5 * 1024 * 1024;

        const sourceS3 = S3Helper.getS3(sourceProfile);
        const destS3 = S3Helper.getS3(destProfile);

        let sourceObjects = await S3Helper.getAllObjects(sourceS3, sourceBucketName);

        if (GlobalData.AbortSignal === true) {

            self.sendTrigger('copyBucket@abort');
            GlobalData.AppInProcess = false;

            return;
        }

        const objectsCount = sourceObjects.length;

        let objectIndex = 0;
        let objectKey = null;
        let objectPercent = 0;

        const progress = () => {

            let mainPercent = (100 * objectIndex + objectPercent) / objectsCount;

            self.sendTrigger('copyBucket@progress', {
                mainProgress: objectIndex + 1,
                mainTotal: objectsCount,
                mainPercent: mainPercent,
                objectKey: objectKey,
                objectPercent: objectPercent
            });
        };

        let destObjects = await S3Helper.getAllObjects(destS3, destBucketName);

        for (let i = 0; i < objectsCount; i++) {

            if (GlobalData.AbortSignal === true) {

                self.sendTrigger('copyBucket@abort');
                GlobalData.AppInProcess = false;

                return;
            }


            objectKey = sourceObjects[i].Key;
            objectIndex = i;

            let destIndex = destObjects.findIndex(value => (value.Key === sourceObjects[i].Key && value.Size === sourceObjects[i].Size));

            if(destIndex > -1){
                objectPercent = 100;
                progress();
                continue;
            }
            else{
                objectPercent = 0;
                progress();
            }

            sourceObjects[i].IsPublic = await S3Helper.isPublicObject(sourceS3, sourceBucketName, sourceObjects[i].Key);
            sourceObjects[i].TempPath = await S3Helper.downloadObjectInTemp(sourceS3, sourceBucketName, sourceObjects[i].Key);

            objectPercent = 30;

            progress();

            if (sourceObjects[i].Size < maxSingleUploadSize) {

                await S3Helper.putObjectInBucket(destS3, destBucketName, sourceObjects[i].TempPath, sourceObjects[i].Key, sourceObjects[i].IsPublic)
                fs.remove(sourceObjects[i].TempPath);

                objectPercent = 100;

                progress();
            }
            else {

                await new Promise((resolve, reject) => {

                    const mPart = S3Helper.putObjectInBucketMultiPart(destS3, destBucketName, sourceObjects[i].TempPath, sourceObjects[i].Key, sourceObjects[i].IsPublic);

                    mPart.on("error", async (e) => {

                        await fs.remove(sourceObjects[i].TempPath);

                        reject(e);

                    });

                    mPart.on("abort", async () => {

                        await fs.remove(sourceObjects[i].TempPath);

                        self.sendTrigger('copyBucket@abort');

                        GlobalData.AppInProcess = false;

                        reject();


                    });

                    mPart.on("end", async (response) => {

                        await fs.remove(sourceObjects[i].TempPath);

                        objectPercent = 100;

                        progress();

                        resolve(response);

                    });

                    mPart.on("progress", (doneCount, totalCount) => {

                        objectPercent = 30 + (doneCount * 70 / totalCount);

                        progress();

                    });
                });

            }

        }

        GlobalData.AppInProcess = false;

        self.sendTrigger('copyBucket@end');

    }

    async copyBucket(sourceProfile, sourceBucketName, destProfile, destBucketName) {

        GlobalData.AbortSignal = false;
        GlobalData.AppInProcess = true;

        const self = this;
        const maxSingleUploadSize = 5 * 1024 * 1024;

        const sourceS3 = S3Helper.getS3(sourceProfile);
        const destS3 = S3Helper.getS3(destProfile);


        const sourceObjects = await S3Helper.getAllObjects(sourceS3, sourceBucketName);

        const objectsCount = sourceObjects.length;

        let objectIndex = 0;
        let objectKey = null;
        let objectPercent = 0;

        const progress = () => {

            let mainPercent = (100 * objectIndex + objectPercent) / objectsCount;

            self.sendTrigger('copyBucket@progress', {
                mainProgress: objectIndex + 1,
                mainTotal: objectsCount,
                mainPercent: mainPercent,
                objectKey: objectKey,
                objectPercent: objectPercent
            });
        };

        for (let i = 0; i < objectsCount; i++) {

            if (GlobalData.AbortSignal === true) {

                self.sendTrigger('copyBucket@abort');
                GlobalData.AppInProcess = false;

                return;
            }

            objectPercent = 0;
            objectKey = sourceObjects[i].Key;
            objectIndex = i;

            progress();

            sourceObjects[i].IsPublic = await S3Helper.isPublicObject(sourceS3, sourceBucketName, sourceObjects[i].Key);
            sourceObjects[i].TempPath = await S3Helper.downloadObjectInTemp(sourceS3, sourceBucketName, sourceObjects[i].Key);

            objectPercent = 30;

            progress();

            if (sourceObjects[i].Size < maxSingleUploadSize) {

                await S3Helper.putObjectInBucket(destS3, destBucketName, sourceObjects[i].TempPath, sourceObjects[i].Key, sourceObjects[i].IsPublic)
                fs.remove(sourceObjects[i].TempPath);

                objectPercent = 100;

                progress();
            }
            else {

                await new Promise((resolve, reject) => {

                    const mPart = S3Helper.putObjectInBucketMultiPart(destS3, destBucketName, sourceObjects[i].TempPath, sourceObjects[i].Key, sourceObjects[i].IsPublic);

                    mPart.on("error", async (e) => {

                        await fs.remove(sourceObjects[i].TempPath);

                        reject(e);

                    });

                    mPart.on("abort", async () => {

                        await fs.remove(sourceObjects[i].TempPath);

                        self.sendTrigger('copyBucket@abort');

                        GlobalData.AppInProcess = false;

                        reject();


                    });

                    mPart.on("end", async (response) => {

                        await fs.remove(sourceObjects[i].TempPath);

                        objectPercent = 100;

                        progress();

                        resolve(response);

                    });

                    mPart.on("progress", (doneCount, totalCount) => {

                        objectPercent = 30 + (doneCount * 70 / totalCount);

                        progress();

                    });
                });

            }

        }

        GlobalData.AppInProcess = false;

        self.sendTrigger('copyBucket@end');

    }

    async cancelOperation() {

        GlobalData.AbortSignal = true;

    }

    async mountBucket(profile, bucketName){

        let temp_url = profile
            .endpoint_url
            .trim()
            .replace("https://s3.", "")
            .replace("http://s3.", "");

        let region = temp_url.substring(0, temp_url.indexOf("."));

        let config = `
[s3]
type = s3
provider = Other
access_key_id = ${profile.access_key}
secret_access_key = ${profile.secret_key}
region = ${region}
endpoint = ${profile.endpoint_url}
storage_class = STANDARD`;

        await fs.writeFile("rclone/rclone-config.conf", config);

        if(GlobalData.RClone){
            GlobalData.RClone.kill();
        }

        return await new Promise((resolve, reject) => {

            GlobalData.RClone = spawn('rclone\\rclone', ['mount', 's3:' + bucketName, 'S:', '--vfs-cache-mode', 'full'], {
                env: {
                    ...process.env,
                    RCLONE_CONFIG: "rclone\\rclone-config.conf"
                }
            });

            // GlobalData.RClone.stdout.on('data', (data) => {
            //     console.log(`stdout: ${data}`);
            // });

            GlobalData.RClone.stderr.on('data', (data) => {

                if(`${data}`.trim() == `The service rclone has been started.`){
                    resolve();
                }
                else{
                    reject(`${data}`);
                    // first data buffer reject and for more details log here
                    console.log(`stderr: ${data}`);
                }

            });

            // GlobalData.RClone.on('close', (code) => {
            //     console.log(`child process exited with code ${code}`);
            // });

        });

    }
}

const instance = new BucketsChannel();

module.exports = instance;
