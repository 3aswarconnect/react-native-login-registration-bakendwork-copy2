import dotenv from "dotenv";
import express from 'express'
import cors from "cors";
import multer from 'multer';
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import  { DynamoDBClient, PutItemCommand, GetItemCommand,ScanCommand,QueryCommand,UpdateItemCommand  } from "@aws-sdk/client-dynamodb";
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
    const TABLE_NAME = 'youtube-demos';
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ message: "Username, Email, and Password are required" });
    }

    // Check if user already exists
    const queryCommand = new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'email-index', // Ensure a GSI exists for email lookup
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": { S: email } }
    });

    try {
        const existingUser = await client.send(queryCommand);
        if (existingUser.Items.length > 0) {
            return res.status(400).json({ message: "Email is already registered" });
        }

        // Check if username already exists
        const usernameQuery = new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: 'username-index', // Ensure a GSI exists for username lookup
            KeyConditionExpression: "username = :username",
            ExpressionAttributeValues: { ":username": { S: username } }
        });

        const existingUsername = await client.send(usernameQuery);
        if (existingUsername.Items.length > 0) {
            return res.status(400).json({ message: "Username is already taken" });
        }

        // Proceed with registration
        const userId = uuidv4();
        const putItemCommand = new PutItemCommand({
            TableName: TABLE_NAME,
            Item: {
                userId: { S: userId },
                username: { S: username },
                email: { S: email },
                password: { S: password }
            }
        });

        await client.send(putItemCommand);
        res.json({ message: "User registered successfully", userId });

    } catch (error) {
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

        // Upload main file to S3
        await s3.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileName,
            Body: file.buffer,
            ContentType: file.mimetype,
        }));

        let docFileUrl = null;
        let docFileName = null;
        console.log(req.files.docfile);
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
                ...(docFileUrl && { docFileUrl: { S: docFileUrl } }),
                ...(docFileName && { docFileName: { S: docFileName } }),
            },
        }));

        res.json({ 
            message: 'Upload successful', 
            fileId, 
            fileUrl, 
            fileType,
            docFileUrl 
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
                docFileUrl: video.docFileUrl || null,  // Include docFileUrl in the response
                docFileName: video.docFileName || null  // Include docFileName in the response
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
const photoupload = multer({ storage });

// Profile Update API (POST)
app.post('/profile-send', photoupload.single('file'), async (req, res) => {
   
    const { userId, username, name, bio, socialLinks } = req.body;
  console.log(socialLinks);
    if (!userId) return res.status(400).json({ message: 'User ID is required' });
    
    try {
        // Create a DynamoDB item with the base profile data
        const profileItem = {
            userId: { S: userId },     // Primary Key (userId)
            username: { S: username }, // Username
            name: { S: name },         // User's name
            bio: { S: bio },           // Bio
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

        // Store profile data in DynamoDB
        await client.send(new PutItemCommand({
            TableName: 'profile', // Assuming 'profile' is the DynamoDB table name
            Item: profileItem,
        }));

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
       
        
        // ✅ Fix: Correctly extract the userId from DynamoDB format
        const userProfile = data.Items.find(user => user.userId.S === userId);
        
        if (!userProfile) {
            return res.status(404).json({ message: 'Profile not found' });
        }
        
        // ✅ Fix: Extract string values correctly and include socialLinks
        const response = {
            name: userProfile.name?.S || '',
            bio: userProfile.bio?.S || '',
            profilePic: userProfile.profilePhotoUrl?.S || '',
            username: userProfile.username?.S || ''
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
        
        res.json(response);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching profile: ' + error.message });
    }
});

//profile user data
app.get('/getUserMedia', async (req, res) => {
    const { userId } = req.query;
 console.log("user s sssss",userId);
    if (!userId) {
        return res.status(400).json({ message: "User ID is required" });
    }

    try {
        // Fetch media items belonging to the user
        const command = new ScanCommand({
            TableName: 'storage', // Ensure this table stores user media
            FilterExpression: "userId = :userId",
            ExpressionAttributeValues: {
                ":userId": { S: userId }
            }
        });

        const data = await client.send(command);

        // Convert DynamoDB response to normal JSON
        const mediaItems = data.Items.map(item => unmarshall(item));
       console.log(mediaItems);
        res.json(mediaItems);
        
    } catch (error) {
        console.error("Error fetching user media:", error);
        res.status(500).json({ message: "Failed to fetch user media" });
    }
});


// **Start Server**
app.listen(4000, () => console.log("Server running on port 4000"));