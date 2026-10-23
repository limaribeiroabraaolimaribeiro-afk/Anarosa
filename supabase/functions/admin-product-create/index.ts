import { serve } from '../_shared/context.ts';
import { productSave } from '../_shared/product-save.ts';
serve(productSave(false));
