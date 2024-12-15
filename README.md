<p align="center">
  <img src="public/bigico.ico" alt="GoesSite Icon" width="100" />
</p>

<h1 align="center">GoesSite</h1>
<br/><br/>

## Prerequisites

- **Node.js**: You will need [Node.js](https://nodejs.org/) installed on your machine. It is recommended to use the latest stable version.
- **npm**: Node Package Manager (npm) comes with Node.js and is used to install the app's dependencies.
- **Data**: Some data from the goes sattelites to play with

## Installation

### 1. Clone the repository
First, clone the repository to your local machine using Git:

```bash
git clone https://github.com/KillaMeep/goes-data.git
```
Then, cd into the new directory.
```bash
cd GoesSite
```

### 2. Install Dependencies
```bash
npm install
```

### 2.1. Configure the code to run from your mount

Because we have the code checking a remote location for the images to host, we need to set that up properly. Heres the example setup:

```js
// Base directory for the mounted SMB share
// POINT TO YOUR IMAGES
const baseDirectory = '/mnt/plexy/Weather/GOES';  // <--- change that
```
We don't necessarily need it to be a SMB share, but thats what I'm running it off of. You can run this off of a local drive if you want as well.

### 3. Run the server!
```bash
npm run prod
```
### 4. Done!

The server should now be running, accessible from `localhost:5000`!

