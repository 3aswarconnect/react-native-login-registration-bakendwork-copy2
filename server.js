import dotenv from "dotenv";
import express from 'express'
import cors from "cors";
import multer from 'multer';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import  { DynamoDBClient, PutItemCommand, GetItemCommand,ScanCommand,QueryCommand,UpdateItemCommand ,BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from "crypto";
import { unmarshall } from '@aws-sdk/util-dynamodb';
import path from "path";
import { v4 as uuidv4 } from "uuid";

dotenv.config()
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }))
app.use(cors({ origin: "*" }));
//s3
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});
const BUCKET_NAME = process.env.AWS_S3_BUCKET;
const client = new DynamoDBClient({
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

app.post("/register", async (req, res) => {
    const USER_TABLE = 'youtube-demos';
    const PROFILE_TABLE = 'profile';
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Username and Password are required" });
    }

    try {
        // Check if username already exists
        const usernameQuery = new QueryCommand({
            TableName: USER_TABLE,
            IndexName: 'username-index',
            KeyConditionExpression: "username = :username",
            ExpressionAttributeValues: { ":username": { S: username } }
        });

        const existingUsername = await client.send(usernameQuery);
        if (existingUsername.Items.length > 0) {
            return res.status(400).json({ message: "Username is already taken" });
        }

        // Create registration timestamp
        const registeredAt = new Date().toISOString();
        
        // Generate unique userId with collision check
        let userId;
        let isUniqueId = false;
        
        while (!isUniqueId) {
            // Generate a new UUID
            userId = uuidv4();
            
            // Check if userId already exists in USER_TABLE
            const userIdQuery = new GetItemCommand({
                TableName: USER_TABLE,
                Key: {
                    userId: { S: userId }
                }
            });
            
            const existingUser = await client.send(userIdQuery);
            
            // If no item found with this ID, it's unique
            if (!existingUser.Item) {
                isUniqueId = true;
            }
            // Otherwise, loop will continue and generate a new UUID
        }
        
        // Now we have a guaranteed unique userId
        
        // 1. Store in main user table
        const putUserCommand = new PutItemCommand({
            TableName: USER_TABLE,
            Item: {
                userId: { S: userId },
                username: { S: username },
                password: { S: password },
                registeredAt: { S: registeredAt }
            }
        });

        // 2. Store in profile table
        const putProfileCommand = new PutItemCommand({
            TableName: PROFILE_TABLE,
            Item: {
                userId: { S: userId },
                username: { S: username },
                registeredAt: { S: registeredAt },
                bio: { S: "" },
                avatarUrl: { S: "" }
            }
        });

        // Execute both operations
        await Promise.all([
            client.send(putUserCommand),
            client.send(putProfileCommand)
        ]);
        
        res.json({ 
            message: "User registered successfully", 
            userId, 
            username,
            registeredAt,
            token: "your-token-here" // Include your actual token generation logic
        });

    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: error.message });
    }
});


 

// **Sign In User**
app.post("/signin", async (req, res) => {
    const TABLE_NAME = 'youtube-demos';
    const { identifier, password } = req.body; // identifier can be email or username
    

    if (!identifier || !password) {
        return res.status(400).json({ message: "Username/Email and Password are required" });
    }

    const scanCommand = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: "email = :identifier OR username = :identifier",
        ExpressionAttributeValues: {
            ":identifier": { S: identifier }
        }
    });

    try {
        const response = await client.send(scanCommand);
        
        if (!response.Items || response.Items.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        const user = response.Items[0];
        
        if (user.password?.S === password) {
            res.json({
                message: "Login successful",
                userId: user.userId?.S,
                username: user.username?.S, // Add username
                email: user.email?.S // Add email
            });
        } else {
            res.status(401).json({ message: "Invalid credentials" });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});



//upload
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Upload API


app.post('/upload', upload.fields([{ name: 'file' }, { name: 'docfile' }]), async (req, res) => {
   
    const { category, description, isPublic, userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'User ID is required' });
    if (!req.files || !req.files.file) return res.status(400).json({ message: 'No file uploaded' });

    try {
        const file = req.files.file[0];
        const fileId = uuidv4();
        const fileType = file.mimetype.startsWith('image') ? 'image' : 'video';
        const fileName = `${fileId}-${file.originalname}`;
        const fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

        // Get current timestamp
        const timestamp = new Date().toISOString();

        // Upload main file to S3
        await s3.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype,
        }));

        let docFileUrl = null;
        let docFileName = null;
        // If docfile is provided, upload it
        if (req.files.docfile) {
            const docfile = req.files.docfile[0];

            const docFileId = uuidv4();
            docFileName = `${docFileId}-${docfile.originalname}`;
            docFileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${docFileName}`;

            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: docFileName,
                Body: docfile.buffer,
                ContentType: docfile.mimetype,
            }));
        }

        // Store details in DynamoDB
        await client.send(new PutItemCommand({
            TableName: 'storage',
            Item: {
                fileId: { S: fileId },
                userId: { S: userId },
                category: { S: category },
                description: { S: description },
                isPublic: { BOOL: isPublic === 'true' },
                fileName: { S: file.originalname },
                fileUrl: { S: fileUrl },
                fileType: { S: fileType },
                timestamp: { S: timestamp }, // Added timestamp
                ...(docFileUrl && { docFileUrl: { S: docFileUrl } }),
                ...(docFileName && { docFileName: { S: docFileName } }),
            },
        }));

        res.json({ 
            message: 'Upload successful', 
            fileId, 
            fileUrl, 
            fileType,
            docFileUrl,
            timestamp // Return timestamp in response
        });
    } catch (error) {
        res.status(500).json({ message: 'Upload failed: ' + error.message });
    }
});



app.get('/reels', async (req, res) => {
    const category = req.query.category;
    
    try {
        const data = await client.send(new ScanCommand({ TableName: 'storage' }));
        let videos = data.Items.map(item => {
            const video = unmarshall(item);
            return {
                ...video,
                userId: video.userId,
                docFileUrl: video.docFileUrl || null,
                docFileName: video.docFileName || null,
                views: video.views || 0 // Include views count, default to 0 if not set
            };
        }).filter(video => video.fileType === 'video');
        
        if (category && category !== 'All') {
            videos = videos.filter(video => video.category === category);
        }
        
        res.json(videos);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching videos: ' + error.message });
    }
});

app.get('/memes', async (req, res) => {
    const category = req.query.category;
    


    try {
        const data = await client.send(new ScanCommand({ TableName: 'storage' }));
        let memes = data.Items.map(item => unmarshall(item)).filter(meme => meme.fileType === 'image');

        if (category && category !== 'All') {
            memes = memes.filter(meme => meme.category === category);
        }

        res.json(memes);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching memes: ' + error.message });
    }
});

const photostorage = multer.memoryStorage();
const photoupload = multer({ storage: photostorage });  // Fixed the variable reference

// Profile Update API (POST)
app.post('/profile-send', photoupload.single('file'), async (req, res) => {
    const { userId, username, name, bio, socialLinks, email } = req.body;
    
    console.log(socialLinks);
    
    if (!userId) return res.status(400).json({ message: 'User ID is required' });
    
    try {
        // Create a DynamoDB item with the base profile data
        const profileItem = {
            userId: { S: userId },     // Primary Key (userId)
            username: { S: username }, // Username
            name: { S: name },         // User's name
            bio: { S: bio },           // Bio
            email: { S: email }        // Email field
        };
        
        // Handle file upload if a file is provided
        if (req.file) {
            // Generate unique file ID for the profile photo
            const fileId = uuidv4();
            
            const fileName = `${fileId}-${req.file.originalname}`;
            const fileUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
            
            // Upload the profile photo to S3
            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: fileName,
                Body: req.file.buffer,
                ContentType: req.file.mimetype,
            }));
            
            // Add the profile photo URL to the DynamoDB item
            profileItem.profilePhotoUrl = { S: fileUrl };
        }
        
        // Handle social links if provided
        if (socialLinks) {
            try {
                // Parse social links from JSON string to array
                const parsedLinks = JSON.parse(socialLinks);
                
                // Validate social links
                if (Array.isArray(parsedLinks) && parsedLinks.length <= 5) {
                    // Add social links as a list of maps in DynamoDB
                    profileItem.socialLinks = { 
                        L: parsedLinks.map(link => ({
                            M: {
                                name: { S: link.name },
                                url: { S: link.url },
                                platform: { S: link.platform }
                            }
                        }))
                    };
                }
            } catch (parseError) {
                console.error('Error parsing social links:', parseError);
                // Continue execution even if social links parsing fails
            }
        }
    
        // Create a parallel promise array for both table operations
        const dbOperations = [
            // Store profile data in the 'profile' table
            client.send(new PutItemCommand({
                TableName: 'profile',
                Item: profileItem,
            })),
            
            // Selectively update email in the 'youtube-demos' table
            client.send(new UpdateItemCommand({
                TableName: 'youtube-demos',
                Key: {
                    userId: { S: userId }
                },
                UpdateExpression: 'SET email = :email',
                ExpressionAttributeValues: {
                    ':email': { S: email }
                },
                ReturnValues: 'NONE'
            }))
        ];
        
        // Execute both operations in parallel
        await Promise.all(dbOperations);
    
        // Respond back with success message and profile photo URL if it was updated
        const response = {
            message: 'Profile updated successfully'
        };
        
        if (profileItem.profilePhotoUrl) {
            response.profilePhotoUrl = profileItem.profilePhotoUrl.S;
        }
        
        res.json(response);
    } catch (error) {
        console.error('Profile update error:', error);
        res.status(500).json({ message: 'Profile update failed: ' + error.message });
    }
});

app.get('/profileget', async (req, res) => {
    const userId = req.query.userId;
    
    if (!userId) {
        return res.status(400).json({ message: 'User ID is required' });
    }
    
    try {
        const data = await client.send(new ScanCommand({ TableName: 'profile' }));
       
        // Correctly extract the userId from DynamoDB format
        const userProfile = data.Items.find(user => user.userId.S === userId);
        
        if (!userProfile) {
            return res.status(404).json({ message: 'Profile not found' });
        }
        
        // Extract string values correctly and include all fields including timestamp
        const response = {
            name: userProfile.name?.S || '',
            bio: userProfile.bio?.S || '',
            profilePic: userProfile.profilePhotoUrl?.S || '',
            username: userProfile.username?.S || '',
            registeredAt: userProfile.registeredAt?.S || null // Add the registration timestamp
        };
        
        // Extract and transform socialLinks if they exist
        if (userProfile.socialLinks && userProfile.socialLinks.L) {
            response.socialLinks = userProfile.socialLinks.L.map(link => ({
                name: link.M.name.S,
                url: link.M.url.S,
                platform: link.M.platform.S
            }));
        } else {
            response.socialLinks = [];
        }

        // If registeredAt exists, calculate days since registration
        if (response.registeredAt) {
            const registrationDate = new Date(response.registeredAt);
            const currentDate = new Date();
            const differenceInTime = currentDate.getTime() - registrationDate.getTime();
            const differenceInDays = Math.floor(differenceInTime / (1000 * 3600 * 24));
            
            response.accountAgeDays = differenceInDays;
            
        }
        
        res.json(response);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching profile: ' + error.message });
    }
});

//profile user data
// Enhanced getUserMedia endpoint - replace your existing one with this

app.get('/getUserMedia', async (req, res) => {
    const { userId, category } = req.query;
    console.log("Received request for user media:", { userId, category });
    
    if (!userId) {
        console.log("Rejected request: Missing userId");
        return res.status(400).json({ 
            message: "User ID is required",
            success: false
        });
    }

    try {
        // Build FilterExpression dynamically based on whether category is provided
        let filterExpression = "userId = :userId";
        let expressionAttributeValues = {
            ":userId": { S: userId }
        };
        
        // Add category filter if provided
        if (category && category !== 'All') {
            filterExpression += " AND category = :category";
            expressionAttributeValues[":category"] = { S: category };
        }
        
        console.log("DynamoDB query:", { 
            filterExpression,
            expressionAttributeValues 
        });
        
        // Fetch media items belonging to the user with optional category filter
        const command = new ScanCommand({
            TableName: 'storage',
            FilterExpression: filterExpression,
            ExpressionAttributeValues: expressionAttributeValues
        });

        const data = await client.send(command);
        console.log(`Found ${data.Items?.length || 0} items in DynamoDB`);

        if (!data.Items || data.Items.length === 0) {
            // Return empty array with 200 status - this is not an error
            return res.json([]);
        }
        
        // Convert DynamoDB response to normal JSON
        const mediaItems = data.Items.map(item => {
            const unmarshalled = unmarshall(item);
            // Ensure fileType is set even if missing in the database
            if (!unmarshalled.fileType) {
                // Determine fileType from fileUrl if possible
                const fileUrl = unmarshalled.fileUrl || '';
                if (fileUrl.match(/\.(mp4|mov|avi|wmv)$/i)) {
                    unmarshalled.fileType = 'video';
                } else if (fileUrl.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                    unmarshalled.fileType = 'image';
                } else {
                    // Default to image if can't determine
                    unmarshalled.fileType = 'image';
                }
            }
            return unmarshalled;
        });
        
        console.log(`Returning ${mediaItems.length} processed items`);
        res.json(mediaItems);
        
    } catch (error) {
        console.error("Error fetching user media:", error);
        res.status(500).json({ 
            message: "Failed to fetch user media",
            error: error.message,
            success: false
        });
    }
});


app.get('/search-users', async (req, res) => {
    const { username } = req.query;
   
    if (!username) {
        return res.status(400).json({ 
            message: 'Username query is required',
            success: false 
        });
    }

    try {
        const command = new ScanCommand({
            TableName: 'profile',
            TableName: 'profile'
        });

        const data = await client.send(command);

        // Perform case-insensitive filtering in JavaScript
        const users = data.Items
            .filter(item => {
                const itemUsername = item.username?.S?.toLowerCase() || '';
                const searchTerm = username.toLowerCase();
                return itemUsername.includes(searchTerm);
            })
            .map(item => ({
                userId: item.userId?.S || '',
                username: item.username?.S || '',
                name: item.name?.S || '',
                profilePhotoUrl: item.profilePhotoUrl?.S || '',
                bio: item.bio?.S || '',
                email: item.email?.S || ''
            }));

        res.json({
            success: true,
            users,
            totalResults: users.length
        });
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json({ 
            message: 'Failed to search users', 
            error: error.message,
            success: false 
        });
    }
});


// Add this to your backend code (server.js)
// Update your /increment-views endpoint in server.js
app.post('/increment-views', async (req, res) => {
    const { videoIds } = req.body;
  console.log(videoIds);
    if (!videoIds || !Array.isArray(videoIds)) {
        return res.status(400).json({ message: 'Video IDs array is required' });
    }

    try {
        // Process updates with limited concurrency
        const concurrency = 10; // Adjust based on your DynamoDB capacity
        const batches = [];
        
        for (let i = 0; i < videoIds.length; i += concurrency) {
            batches.push(videoIds.slice(i, i + concurrency));
        }

        const results = [];
        let successCount = 0;

        for (const batch of batches) {
            const batchResults = await Promise.allSettled(
                batch.map(fileId => {
                    const updateCommand = new UpdateItemCommand({
                        TableName: 'storage',
                        Key: { fileId: { S: fileId } },
                        UpdateExpression: 'SET #views = if_not_exists(#views, :zero) + :incr',
                        ExpressionAttributeNames: {
                            '#views': 'views'
                        },
                        ExpressionAttributeValues: {
                            ':incr': { N: '1' },
                            ':zero': { N: '0' }
                        },
                        ReturnValues: 'NONE'
                    });
                    return client.send(updateCommand);
                })
            );

            batchResults.forEach((result, index) => {
                const fileId = batch[index];
                if (result.status === 'fulfilled') {
                    successCount++;
                    results.push({ fileId, status: 'success' });
                } else {
                    results.push({ 
                        fileId, 
                        status: 'failed', 
                        error: result.reason.message 
                    });
                }
            });
        }

        res.json({ 
            message: 'Views update processed',
            successCount,
            failedCount: videoIds.length - successCount,
            results
        });
    } catch (error) {
        console.error('Error in increment-views endpoint:', error);
        res.status(500).json({ 
            message: 'Failed to process view updates', 
            error: error.message,
            details: error
        });
    }
});



// Add a streak to a profile
app.post('/add-streak', async (req, res) => {
    const { profileUserId, watchUserId } = req.body;
    
    if (!profileUserId || !watchUserId) {
        return res.status(400).json({
            success: false,
            message: "Both profile user ID and watch user ID are required"
        });
    }
    
    // Don't allow users to give streaks to themselves
    if (profileUserId === watchUserId) {
        return res.status(400).json({
            success: false,
            message: "You cannot give a streak to your own profile"
        });
    }
    
    try {
        // First check if the user has already given a streak
        const getCommand = new GetItemCommand({
            TableName: 'streaks',
            Key: {
                profileUserId: { S: profileUserId }
            }
        });
        
        const response = await client.send(getCommand);
        
        // If record exists, check if user already gave a streak
        if (response.Item) {
            const streakData = unmarshall(response.Item);
            const streakUsers = streakData.streakUsers || [];
            
            // If user already gave a streak, return error
            if (streakUsers.includes(watchUserId)) {
                return res.status(400).json({
                    success: false,
                    message: "You have already given a streak to this profile",
                    streakCount: streakData.streakCount || 0
                });
            }
            
            // User hasn't given a streak yet, update the record
            const streakCount = parseInt(streakData.streakCount || 0) + 1;
            streakUsers.push(watchUserId);
            
            const updateCommand = new UpdateItemCommand({
                TableName: 'streaks',
                Key: {
                    profileUserId: { S: profileUserId }
                },
                UpdateExpression: 'SET streakCount = :count, streakUsers = :users',
                ExpressionAttributeValues: {
                    ':count': { N: streakCount.toString() },
                    ':users': { L: streakUsers.map(id => ({ S: id })) }
                },
                ReturnValues: 'ALL_NEW'
            });
            
            const updateResponse = await client.send(updateCommand);
            const updatedItem = updateResponse.Attributes ? unmarshall(updateResponse.Attributes) : null;
            
            return res.json({
                success: true,
                message: "Streak given successfully",
                streakCount: updatedItem?.streakCount || streakCount
            });
            
        } else {
            // No streak record exists yet, create a new one
            const streakItem = {
                profileUserId: { S: profileUserId },
                streakCount: { N: "1" },
                streakUsers: { L: [{ S: watchUserId }] },
                updatedAt: { S: new Date().toISOString() }
            };
            
            const putCommand = new PutItemCommand({
                TableName: 'streaks',
                Item: streakItem
            });
            
            await client.send(putCommand);
            
            return res.json({
                success: true,
                message: "Streak given successfully",
                streakCount: 1
            });
        }
        
    } catch (error) {
        console.error("Error adding streak:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to add streak",
            error: error.message
        });
    }
});


app.get('/check-streak', async (req, res) => {
    const { profileUserId, watchUserId } = req.query;
    
    if (!profileUserId || !watchUserId) {
        return res.status(400).json({ 
            success: false,
            message: "Both profile user ID and watch user ID are required"
        });
    }
    
    try {
        // Get streak record for this profile from DynamoDB
        const getCommand = new GetItemCommand({
            TableName: 'streaks',
            Key: {
                profileUserId: { S: profileUserId }
            }
        });
        
        const response = await client.send(getCommand);
        
        // If no streak record exists yet, return default values
        if (!response.Item) {
            return res.json({
                success: true,
                streakCount: 0,
                hasGivenStreak: false
            });
        }
        
        // Parse the streak data
        const streakData = unmarshall(response.Item);
        const streakCount = parseInt(streakData.streakCount || 0);
        
        // Check if watchUserId is in the streakUsers array
        const streakUsers = streakData.streakUsers || [];
        const hasGivenStreak = streakUsers.includes(watchUserId);
        
        return res.json({
            success: true,
            streakCount,
            hasGivenStreak
        });
        
    } catch (error) {
        console.error("Error checking streak status:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to check streak status",
            error: error.message
        });
    }
});


// Add this to your backend code (server.js)
app.get('/get-streak-count', async (req, res) => {
    const { profileUserId } = req.query;
    
    if (!profileUserId) {
        return res.status(400).json({ 
            success: false,
            message: "Profile user ID is required"
        });
    }
    
    try {
        const getCommand = new GetItemCommand({
            TableName: 'streaks',
            Key: {
                profileUserId: { S: profileUserId }
            }
        });
        
        const response = await client.send(getCommand);
        
        if (!response.Item) {
            return res.json({
                success: true,
                streakCount: 0
            });
        }
        
        const streakData = unmarshall(response.Item);
        const streakCount = parseInt(streakData.streakCount || 0);
        
        return res.json({
            success: true,
            streakCount
        });
        
    } catch (error) {
        console.error("Error getting streak count:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to get streak count",
            error: error.message
        });
    }
});
// **Start Server**
app.listen(4000, () => console.log("Server running on port 4000"));
