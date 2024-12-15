<h1 align="center">GoesSite</h1>
<p align="center">
  <img src="public/bigico.ico" alt="GoesSite Icon" width="100" />
</p>



## 🌟 Prerequisites

Before getting started, make sure you have the following:

- **Node.js**: (Latest stable version recommended).
- **npm**: Comes with Node.js and is used to install dependencies.
- **Redis**: For thumbnail workers
- **Data**: Some data from the GOES satellites to play with.
<br></br>
---

## ⚙️ Installation

### 1. Install NodeJS

If you havn't already, get node.js, and redis.
```properties
sudo apt update
sudo apt install nodejs redis-server
```

You can run this to check if node installed successfully.

```properties
node -v
```
Example output:
`v20.18.1`
<br></br>
### 1.1 Clone the repo
Now, we can clone the repository to your local machine:

```properties
git clone https://github.com/KillaMeep/goes-data.git
```

Then, navigate into the project directory:
```properties
cd GoesSite
```


## 2. Install Dependencies
Run the following to install the required dependencies:
```properties
npm install
```


## 2.1 Configure Image Hosting
By default, the code checks a mounted drive for images. You need to set the correct path for your environment. Update the base directory in your config file:
```js
// Line 19: Base directory for the mounted SMB share
// Line 20: POINT TO YOUR IMAGES
const baseDirectory = '/mnt/plexy/Weather/GOES';  // <-- change this (Line 21)
```
You can use a local drive, or a mounted SMB share for storing your images.

## 3. Run the Server
Start the server with this command:
```properties
npm run prod
```
## 4. 🎉 You're Done!
Your server is now running at `localhost:5000`. Have fun with your data!