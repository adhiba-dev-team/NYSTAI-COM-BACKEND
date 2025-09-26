import prisma from '../../config/db.js';
import { put } from '@vercel/blob';
import path from 'path';
import crypto from 'crypto';
import {
  getCachedProducts,
  setCachedProducts,
  clearCachedProducts,
} from './product.cache.js';
import redisClient from '../../config/redis.js';
import * as productService from './product.service.js';

const randomSuffix = () => crypto.randomBytes(6).toString('hex');

export const createProduct = async (req, res) => {
  try {
    const {
      categoryId,
      name,
      subName,
      code,
      coverDesc,
      mainDesc,
      keyFeatures,
      smartIconsText,
    } = req.body;

    // Parse JSON arrays
    const features = keyFeatures ? JSON.parse(keyFeatures) : [];
    const smartTexts = smartIconsText ? JSON.parse(smartIconsText) : [];

    // 1️⃣ Create product
    const product = await prisma.product.create({
      data: {
        categoryId: Number(categoryId),
        name,
        subName,
        code,
        coverDesc,
        mainDesc,
        keyFeatures: features,
      },
    });

    const uploadedFiles = [];

    // 2️⃣ Helper to upload each file
    const saveFile = async (file, folder, type, text = null) => {
      const ext = path.extname(file.originalname);
      const safeName = path
        .basename(file.originalname, ext)
        .replace(/\s+/g, '_');
      const filename = `${safeName}-${Date.now()}-${randomSuffix()}${ext}`;
      const blobPath = `NYSTAI_MAIN/products/${product.id}/${folder}/${filename}`;

      const blob = await put(blobPath, file.buffer, {
        access: 'public',
        token: process.env.VERCEL_BLOB_RW_TOKEN,
      });

      // Save to ProductImage table
      return await prisma.productMedia.create({
        data: {
          type,
          text,
          imageUrl: blob.url,
          productId: product.id,
        },
      });
    };

    if (req.files?.cover) {
      for (const file of req.files.cover) {
        uploadedFiles.push(await saveFile(file, 'cover', 'cover'));
      }
    }

    if (req.files?.gallery) {
      for (const file of req.files.gallery) {
        uploadedFiles.push(await saveFile(file, 'gallery', 'gallery'));
      }
    }

    if (req.files?.smartIcons) {
      for (let i = 0; i < req.files.smartIcons.length; i++) {
        const file = req.files.smartIcons[i];
        const text = smartTexts[i] || null;
        uploadedFiles.push(await saveFile(file, 'icons', 'smartIcon', text));
      }
    }

    await clearCachedProducts();

    res.status(201).json({
      product,
      images: uploadedFiles,
    });
  } catch (err) {
    console.error('Error creating product:', err);
    res.status(500).json({ message: err.message });
  }
};

export const getProducts = async (req, res) => {
  try {
    const cacheData = await redisClient.get('products');
    if (cacheData) {
      console.log(' Cache hit: products');
      return res.json(JSON.parse(cacheData));
    }

    const products = await productService.getAllProducts();

    await redisClient.setEx('products', 3600, JSON.stringify(products));

    console.log('💾 Cache set: products');
    res.json(products);
  } catch (error) {
    console.error(' getProducts error:', error); 
    res.status(500).json({
      error: 'Server error',
      details: error.message,
    });
  }
};

export const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const product = await prisma.product.findUnique({
      where: { id: parseInt(id) },
      include: {
        images: true, 
        category: true,
      },
    });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json(product);
  } catch (err) {
    console.error('Error fetching product by ID:', err);
    res.status(500).json({ message: err.message });
  }
};

export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.product.findUnique({
      where: { id: parseInt(id) },
      include: { images: true },
    });

    if (!existing)
      return res.status(404).json({ message: 'Product not found' });
    const dataToUpdate = {};
    if (req.body.categoryId)
      dataToUpdate.categoryId = Number(req.body.categoryId);
    if (req.body.name) dataToUpdate.name = req.body.name;
    if (req.body.subName) dataToUpdate.subName = req.body.subName;
    if (req.body.code) dataToUpdate.code = req.body.code;
    if (req.body.coverDesc) dataToUpdate.coverDesc = req.body.coverDesc;
    if (req.body.mainDesc) dataToUpdate.mainDesc = req.body.mainDesc;
    if (req.body.keyFeatures)
      dataToUpdate.keyFeatures = JSON.parse(req.body.keyFeatures);
    const product = await prisma.product.update({
      where: { id: parseInt(id) },
      data: dataToUpdate,
    });
    const uploadedFiles = [];
    const saveFile = async (file, folder, type, text = null) => {
      const ext = path.extname(file.originalname);
      const safeName = path
        .basename(file.originalname, ext)
        .replace(/\s+/g, '_');
      const filename = `${safeName}-${Date.now()}-${crypto
        .randomBytes(6)
        .toString('hex')}${ext}`;
      const blobPath = `NYSTAI_MAIN/products/${product.id}/${folder}/${filename}`;

      const blob = await put(blobPath, file.buffer, {
        access: 'public',
        token: process.env.VERCEL_BLOB_RW_TOKEN,
      });

      return await prisma.productMedia.create({
        data: { type, text, imageUrl: blob.url, productId: product.id },
      });
    };
    if (req.files?.cover) {
      await prisma.productMedia.deleteMany({
        where: { productId: product.id, type: 'cover' },
      });
      for (const file of req.files.cover)
        uploadedFiles.push(await saveFile(file, 'cover', 'cover'));
    }

    if (req.files?.gallery) {
      await prisma.productMedia.deleteMany({
        where: { productId: product.id, type: 'gallery' },
      });
      for (const file of req.files.gallery)
        uploadedFiles.push(await saveFile(file, 'gallery', 'gallery'));
    }

    if (req.files?.smartIcons) {
      const smartTexts = req.body.smartIconsText
        ? JSON.parse(req.body.smartIconsText)
        : [];
      await prisma.productMedia.deleteMany({
        where: { productId: product.id, type: 'smartIcon' },
      });
      for (let i = 0; i < req.files.smartIcons.length; i++) {
        const file = req.files.smartIcons[i];
        const text = smartTexts[i] || null;
        uploadedFiles.push(await saveFile(file, 'icons', 'smartIcon', text));
      }
    }

    // 🔄 Clear cache after update
    await clearCachedProducts();

    res.json({
      message: 'Product updated successfully',
      product,
      images: uploadedFiles,
    });
  } catch (err) {
    console.error('Error updating product:', err);
    res.status(500).json({ message: err.message });
  }
};

export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.product.findUnique({
      where: { id: parseInt(id) },
    });
    if (!existing)
      return res.status(404).json({ message: 'Product not found' });

    await prisma.product.delete({ where: { id: parseInt(id) } });

    // 🔄 Clear cache after delete
    await clearCachedProducts();

    res.json({
      message: 'Product and all related images deleted successfully',
    });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ message: err.message });
  }
};
